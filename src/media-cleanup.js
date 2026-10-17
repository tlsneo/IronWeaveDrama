import { unlink, open } from 'node:fs/promises';
import { mediaDirectory, mediaPath } from './media-files.js';

// 只处理持久待办中的 UUID；不扫描目录、不递归删除、不触碰旧 BLOB。
export async function cleanupPendingMedia(db, { directory = mediaDirectory, projectId, limit = 50 } = {}) {
  if (db.isTransaction) throw new Error('媒体清理只能在事务提交后执行。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('媒体清理批次须为 1–100。');
  const where = projectId === undefined ? '' : 'WHERE project_id=?', params = projectId === undefined ? [] : [projectId];
  const rows = db.prepare(`SELECT operation_id FROM media_cleanup ${where} ORDER BY created_at,operation_id LIMIT ?`).all(...params, limit);
  let completed = 0;
  for (const { operation_id: id } of rows) {
    try {
      for (const temporary of [true, false]) {
        await unlink(mediaPath(id, temporary, directory)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const parent = await open(directory, 'r').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (parent) { try { await parent.sync(); } finally { await parent.close(); } }
      completed += Number(db.prepare('DELETE FROM media_cleanup WHERE operation_id=?').run(id).changes);
    } catch {
      db.prepare("UPDATE media_cleanup SET last_error='媒体清理失败，待重试。' WHERE operation_id=?").run(id);
    }
  }
  return { completed, pending: db.prepare(`SELECT count(*) AS n FROM media_cleanup ${where}`).get(...params).n };
}
