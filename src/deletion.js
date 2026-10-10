import { inTransaction } from './database.js';
import { assertCharacterImagesIdle } from './character-images.js';
import { assertEpisodeScriptsIdle } from './episode-scripts.js';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }

export function deleteItem(database, kind, id, projectId, form) {
  if (![id, ...(projectId === undefined ? [] : [projectId])].every(Number.isSafeInteger)) reject(404, '待删除的内容不存在。');
  if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes' || form.getAll('name').length !== 1) reject(400, '请确认要删除的内容。');
  return inTransaction(database, () => {
    let item, redirect;
    if (kind === 'projects') {
      item = database.prepare('SELECT name FROM projects WHERE id = ?').get(id);
      redirect = '/';
    } else if (kind === 'characters' || kind === 'seasons') {
      item = database.prepare(`SELECT name FROM ${kind} WHERE id = ? AND project_id = ?`).get(id, projectId);
      redirect = `/projects/${projectId}?${kind === 'characters' ? 'resource=characters' : 'view=seasons'}`;
    } else if (kind === 'episodes') {
      item = database.prepare('SELECT e.name, e.season_id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ? AND s.project_id = ?').get(id, projectId);
      redirect = `/projects/${projectId}?view=seasons&season=${item?.season_id}`;
    } else if (kind === 'api_configs') {
      item = database.prepare('SELECT name FROM api_configs WHERE id = ?').get(id);
      redirect = '/settings';
    } else reject(404, '待删除的内容不存在。');
    if (!item) reject(404, '待删除的内容不存在，可能已经删除。');
    if (item.name !== form.get('name')) reject(409, '内容名称已变化，请刷新页面后重新确认删除。');
    if (kind === 'characters') assertCharacterImagesIdle(database, [id]);
    if (kind === 'projects') assertCharacterImagesIdle(database, database.prepare('SELECT id FROM characters WHERE project_id = ?').all(id).map(character => character.id));
    if (kind === 'episodes') assertEpisodeScriptsIdle(database, [id]);
    if (kind === 'seasons') assertEpisodeScriptsIdle(database, database.prepare('SELECT id FROM episodes WHERE season_id = ?').all(id).map(episode => episode.id));
    if (kind === 'projects') assertEpisodeScriptsIdle(database, database.prepare('SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.project_id = ?').all(id).map(episode => episode.id));
    database.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(id);
    return { deleted: true, redirect };
  });
}
