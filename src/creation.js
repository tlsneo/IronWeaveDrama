import { inTransaction } from './database.js';

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function readName(form) {
  const name = form.get('name')?.trim() ?? '';
  if (form.getAll('name').length !== 1 || !name || name.length > 80) {
    reject(400, '请填写名称，最多 80 字。');
  }
  return name;
}

export function changeCreation(database, projectId, kind, id, action, form) {
  return inTransaction(database, () => {
    if (!database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) reject(404, '短剧项目不存在');
    const isSeason = kind === 'seasons';
    const parentColumn = isSeason ? 'project_id' : 'season_id';
    let seasonId;
    let item;
    if (id) {
      item = isSeason
        ? database.prepare('SELECT * FROM seasons WHERE id = ? AND project_id = ?').get(id, projectId)
        : database.prepare('SELECT e.* FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ? AND s.project_id = ?').get(id, projectId);
      if (!item) reject(404, isSeason ? '季不存在' : '集不存在');
      seasonId = isSeason ? item.id : item.season_id;
    } else if (!isSeason) {
      const raw = form.get('seasonId') ?? '';
      seasonId = Number(raw);
      if (form.getAll('seasonId').length !== 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(seasonId)) reject(400, '请选择有效的季。');
      if (!database.prepare('SELECT id FROM seasons WHERE id = ? AND project_id = ?').get(seasonId, projectId)) reject(404, '季不存在');
    }
    const parentId = isSeason ? projectId : seasonId;

    if (!id) {
      const name = readName(form);
      const position = database.prepare(`SELECT coalesce(max(position), 0) + 1 AS next FROM ${kind} WHERE ${parentColumn} = ?`).get(parentId).next;
      id = Number(database.prepare(`INSERT INTO ${kind} (${parentColumn}, name, position) VALUES (?, ?, ?)`).run(parentId, name, position).lastInsertRowid);
      if (isSeason) seasonId = id;
    } else if (action === 'move') {
      const direction = form.get('direction');
      if (form.getAll('direction').length !== 1 || !['up', 'down'].includes(direction)) reject(400, '请选择上移或下移。');
      const siblings = database.prepare(`SELECT id, position FROM ${kind} WHERE ${parentColumn} = ? ORDER BY position, id`).all(parentId);
      const index = siblings.findIndex(sibling => sibling.id === id);
      const neighbor = siblings[index + (direction === 'up' ? -1 : 1)];
      if (neighbor) {
        const update = database.prepare(`UPDATE ${kind} SET position = ? WHERE id = ?`);
        update.run(neighbor.position, id);
        update.run(item.position, neighbor.id);
      }
    } else {
      database.prepare(`UPDATE ${kind} SET name = ? WHERE id = ?`).run(readName(form), id);
    }
    return { id, seasonId, redirect: `/projects/${projectId}?view=seasons&season=${seasonId}` };
  });
}
