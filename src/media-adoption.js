import { readFile } from 'node:fs/promises';
import { inTransaction } from './database.js';
import { mediaPath, verifyFile } from './media-files.js';
import { readOperation, publicOperation } from './generation-operations.js';
import { sourceStatus } from './generation-source.js';

const tables = new Set(['character_boards', 'character_references', 'scene_images', 'scene_references', 'look_images', 'production_asset_images']);
function reject(status, message) { throw Object.assign(new Error(message), { status }); }
export function linkedOperation(db, table, id) {
  return db.prepare('SELECT o.* FROM generation_operations o JOIN generated_media_links l ON l.operation_id=o.id WHERE l.table_name=? AND l.row_id=?').get(table, id);
}
export function storedImageBytes(db, table, id, fallback) {
  const row = linkedOperation(db, table, id); return row ? JSON.parse(row.metadata_json).bytes : fallback;
}
export async function readStoredImage(db, table, id) {
  if (!tables.has(table)) reject(400, '图片来源类型无效。');
  const op = linkedOperation(db, table, id);
  if (op) {
    const meta = JSON.parse(op.metadata_json);
    if (meta.bytes > 32 * 1024 * 1024 || !meta.mime_type.startsWith('image/')) reject(400, '参考图超过图片上限。');
    await verifyFile(mediaPath(op.id), meta); return readFile(mediaPath(op.id));
  }
  const row = db.prepare(`SELECT image FROM ${table} WHERE id=?`).get(id);
  if (!row) reject(404, '参考图片不存在。'); return row.image;
}
export async function adoptOperation(db, projectId, id) {
  const row = readOperation(db, id, projectId);
  if (!['saved', 'confirmed'].includes(row.local_state)) reject(409, '必须先完整校验并保存文件，不能采用残片。');
  const meta = JSON.parse(row.metadata_json), source = JSON.parse(row.source_json);
  await verifyFile(mediaPath(id), meta);
  return inTransaction(db, () => {
    const current = readOperation(db, id, projectId), status = sourceStatus(db, current);
    if (status.state !== 'current') reject(409, `${status.label}：${status.reason} 历史媒体保留，不覆盖当前版本。`);
    if (current.adopted) return publicOperation(current);
    let table, column, imageId;
    if (['character', 'scene'].includes(row.kind)) {
      table = row.kind === 'character' ? 'character_boards' : 'scene_images'; column = `${row.kind}_id`;
      imageId = Number(db.prepare(`INSERT INTO ${table}(${column},image,mime,width,height,valid,revision,model,prompt,reference_id) VALUES(?,x'',?,?,?,1,?,?,?,?)`).run(row.target_id, meta.mime_type, meta.width, meta.height, source.revision, source.model, source.prompt, source.referenceId).lastInsertRowid);
    } else if (row.kind === 'look') {
      table = 'look_images';
      imageId = Number(db.prepare("INSERT INTO look_images(look_id,image,mime,width,height,valid,revision,model,prompt,inputs_json) VALUES(?,x'',?,?,?,1,?,?,?,?)").run(row.target_id, meta.mime_type, meta.width, meta.height, source.inputRevision, source.model, source.prompt, JSON.stringify(source.inputs)).lastInsertRowid);
      db.prepare('UPDATE looks SET revision=revision+1 WHERE id=?').run(row.target_id);
    } else if (row.kind === 'test') reject(400, '测试媒体不能作为项目资源采用。');
    else reject(400, '请在镜头或片段页面采用该媒体。');
    db.prepare('INSERT INTO generated_media_links(table_name,row_id,operation_id) VALUES(?,?,?)').run(table, imageId, id);
    db.prepare('UPDATE generation_operations SET adopted=0 WHERE project_id=? AND kind=? AND target_id=?').run(projectId, row.kind, row.target_id);
    db.prepare('UPDATE generation_operations SET adopted=1 WHERE id=?').run(id);
    return { ...publicOperation(row), adopted: true, imageId };
  });
}
