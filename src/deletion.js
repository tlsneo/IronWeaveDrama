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
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return { deleted: true, redirect };
  });
}
