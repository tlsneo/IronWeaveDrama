import { assertProjectOperationsIdle } from './generation-operations.js';
import { inTransaction } from './database.js';
import { assertCharacterImagesIdle } from './character-images.js';
import { assertSceneImagesIdle } from './scene-images.js';
import { assertEpisodeScriptsIdle } from './episode-scripts.js';
import { assertLooksIdle } from './look-locks.js';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }

export function deleteItem(database, kind, id, projectId, form) {
  if (![id, ...(projectId === undefined ? [] : [projectId])].every(Number.isSafeInteger)) reject(404, '待删除的内容不存在。');
  if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes' || form.getAll('name').length !== 1) reject(400, '请确认要删除的内容。');
  return inTransaction(database, () => {
    let item, redirect, table = kind;
    if (kind === 'projects') {
      item = database.prepare('SELECT name FROM projects WHERE id = ?').get(id);
      redirect = '/';
    } else if (kind === 'characters' || kind === 'scenes' || kind === 'seasons') {
      item = database.prepare(`SELECT name FROM ${kind} WHERE id = ? AND project_id = ?`).get(id, projectId);
      redirect = `/projects/${projectId}?${kind === 'seasons' ? 'view=seasons' : `resource=${kind}`}`;
    } else if (kind === 'looks') {
      item = database.prepare('SELECT name FROM looks WHERE id = ? AND project_id = ?').get(id, projectId);
      redirect = `/projects/${projectId}?resource=looks`;
    } else if (kind === 'props' || kind === 'costumes') {
      item = database.prepare('SELECT name FROM production_assets WHERE id = ? AND project_id = ? AND kind = ?').get(id, projectId, kind);
      table = 'production_assets'; redirect = `/projects/${projectId}?resource=${kind}`;
    } else if (kind === 'episodes') {
      item = database.prepare('SELECT e.name, e.season_id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ? AND s.project_id = ?').get(id, projectId);
      redirect = `/projects/${projectId}?view=seasons&season=${item?.season_id}`;
    } else if (kind === 'api_configs') {
      item = database.prepare('SELECT name FROM api_configs WHERE id = ?').get(id);
      redirect = '/settings';
    } else reject(404, '待删除的内容不存在。');
    if (!item) reject(404, '待删除的内容不存在，可能已经删除。');
    if (item.name !== form.get('name')) reject(409, '内容名称已变化，请刷新页面后重新确认删除。');
    if (kind === 'api_configs' && database.prepare("SELECT id FROM generation_operations WHERE config_id=? AND (active=1 OR (ack_json IS NULL AND task_state='delivering')) LIMIT 1").get(id)) reject(409, '此配置仍关联未核对交付，请先在操作历史恢复或核对，避免丢失同一认证身份。');
    if (kind === 'projects') assertProjectOperationsIdle(database, id);
    if (kind === 'projects' && database.prepare("SELECT id FROM generation_operations WHERE project_id=? AND (active=1 OR (task_state='delivering' AND ack_json IS NULL)) LIMIT 1").get(id)) reject(409, '项目仍有活动操作或交付确认未确定；请先在项目生成历史恢复/核对。解除防重锁不等于交付确认或远端取消。');
    if (['episodes', 'seasons'].includes(kind) && database.prepare('SELECT id FROM generation_operations WHERE project_id=? AND active=1 LIMIT 1').get(projectId)) reject(409, '项目有正在接收或尚未核对的生成操作，请先停止并在历史核对。');
    if (kind === 'characters') {
      assertCharacterImagesIdle(database, [id]);
      assertLooksIdle(database, database.prepare('SELECT id FROM looks WHERE character_id = ?').all(id).map(look => look.id));
    }
    if (kind === 'looks') assertLooksIdle(database, [id]);
    if (kind === 'projects') assertLooksIdle(database, database.prepare('SELECT id FROM looks WHERE project_id = ?').all(id).map(look => look.id));
    if (kind === 'scenes') assertSceneImagesIdle(database, [id]);
    if (kind === 'projects') assertSceneImagesIdle(database, database.prepare('SELECT id FROM scenes WHERE project_id = ?').all(id).map(scene => scene.id));
    if (kind === 'projects') assertCharacterImagesIdle(database, database.prepare('SELECT id FROM characters WHERE project_id = ?').all(id).map(character => character.id));
    if (kind === 'episodes') assertEpisodeScriptsIdle(database, [id]);
    if (kind === 'seasons') assertEpisodeScriptsIdle(database, database.prepare('SELECT id FROM episodes WHERE season_id = ?').all(id).map(episode => episode.id));
    if (kind === 'projects') assertEpisodeScriptsIdle(database, database.prepare('SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.project_id = ?').all(id).map(episode => episode.id));
    if (kind === 'projects') {
      // 只登记归属此项目的 UUID；事务失败不能提前删除文件。
      database.prepare('INSERT INTO media_cleanup(operation_id,project_id) SELECT id,project_id FROM generation_operations WHERE project_id=? ON CONFLICT(operation_id) DO NOTHING').run(id);
      database.prepare('DELETE FROM generated_media_links WHERE operation_id IN (SELECT id FROM generation_operations WHERE project_id=?)').run(id);
      database.prepare('DELETE FROM generation_operations WHERE project_id=?').run(id);
    }
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (kind === 'api_configs') database.prepare('DELETE FROM api_protocols WHERE config_id=?').run(id);
    if (projectId !== undefined) {
      // 删除资源/季/集保留项目操作历史，仅清理由级联删除产生的悬空链接。
      for (const images of ['character_boards', 'character_references', 'scene_images', 'scene_references', 'look_images', 'production_asset_images']) {
        database.prepare(`DELETE FROM generated_media_links WHERE table_name=? AND operation_id IN (SELECT id FROM generation_operations WHERE project_id=?) AND NOT EXISTS (SELECT 1 FROM ${images} WHERE id=generated_media_links.row_id)`).run(images, projectId);
      }
    }
    return { deleted: true, redirect, ...(projectId !== undefined ? { message: '内容已删除；项目生成历史和新媒体仍保留，可在历史核对交付，旧来源不可再采用。' } : {}) };
  });
}
