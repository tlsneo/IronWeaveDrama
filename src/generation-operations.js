import { sourceStatus } from './generation-source.js';
import { randomUUID, createHash } from 'node:crypto';
import { generationContext } from './generation-context.js';
export { generationContext } from './generation-context.js';
import { inTransaction } from './database.js';
import { readApiConfig, requireWeaveConfig } from './settings.js';
import { ironRequest, receiveMixed, fetchOutput, acknowledge } from './ironweave-client.js';
import { mediaPath, createMediaFile, publishMedia, syncPublishedMedia, verifyFile, validateMediaFile, mediaDirectory } from './media-files.js';

const running = new WeakMap();
const identity = config => ({ baseUrl: config.baseUrl, model: config.model, keyHash: createHash('sha256').update(config.apiKey).digest('hex') });
function reject(status, message) { throw Object.assign(new Error(message), { status }); }
export function readOperation(db, id, projectId) {
  const row = db.prepare('SELECT * FROM generation_operations WHERE id = ? AND project_id IS ?').get(id, projectId);
  if (!row) reject(404, '生成操作不存在。');
  return row;
}
export function publicOperation(row) {
  const source = JSON.parse(row.source_json);
  return { id: row.id, kind: row.kind, targetId: row.target_id, taskId: row.task_id, taskState: row.task_state, localState: row.local_state,
    sourceVersion: source.revision ?? source.clip?.revision ?? null, sourceHash: source.hash ?? source.inputRevision ?? source.revision ?? null, deliveryConfirmed: !!row.ack_json, active: !!row.active, adopted: !!row.adopted, error: row.error, createdAt: row.created_at,
    mediaUrl: ['saved', 'confirmed'].includes(row.local_state) ? `${row.project_id === null ? '' : `/projects/${row.project_id}`}/operations/${row.id}/media` : null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null };
}
export function listOperations(db, projectId) { return db.prepare('SELECT * FROM generation_operations WHERE project_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(projectId).map(row => ({ ...publicOperation(row), sourceStatus: sourceStatus(db, row) })); }
function configFor(db, row) {
  const config = readApiConfig(db, row.config_id);
  if (config.protocol !== 'ironweave2' || JSON.stringify(identity(config)) !== row.config_json) reject(409, '配置身份已变化；请恢复原地址、模型和认证密钥后核对同一任务，不会重新生成。');
  return config;
}
function update(db, id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE generation_operations SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(key => fields[key]), id);
}
function withRunning(db, id, action) {
  const set = running.get(db) ?? new Set(); running.set(db, set);
  if (set.has(id)) reject(409, '此操作仍在接收中，请先停止当前传输。');
  set.add(id); return action().finally(() => set.delete(id));
}
async function confirm(db, row, config, signal) {
  try {
    // 已保存的固定回执永不本地按期限拒绝：ACK 可能此前已提交成功。
    const ack = await acknowledge(config, row.task_id, JSON.parse(row.metadata_json), { signal });
    inTransaction(db, () => update(db, row.id, { ack_json: JSON.stringify(ack), task_state: 'succeeded', local_state: 'confirmed', active: 0, error: '' }));
  } catch (error) {
    const message = error.upstreamRejected
      ? `媒体已保存，交付确认已拒绝（HTTP ${error.upstreamStatus}：${error.code}）；保留文件及回执，只核对同一回执，不自动重新生成。`
      : `媒体已保存，交付确认未确定${error.code ? `（${error.code}）` : ''}；只核对同一回执。`;
    update(db, row.id, { ...(error.upstreamRejected && error.code === 'delivery_expired' ? { task_state: 'failed' } : {}), error: message, active: 0 });
  }
  return publicOperation(readOperation(db, row.id, row.project_id));
}
export async function generateOperation(db, { projectId, kind, targetId, config, source, endpoint, body, expected }, options = {}) {
  requireWeaveConfig(config);
  const id = randomUUID();
  try {
    inTransaction(db, () => {
      // 准备参考文件可能异步让出；项目若已删除，不留下孤儿操作或提交新推理。
      if (projectId !== null && !db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) reject(404, '项目已删除，未提交生成请求。');
      db.prepare('INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json) VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, kind, targetId, config.id, JSON.stringify(identity(config)), JSON.stringify(source), JSON.stringify({ endpoint, expected }));
    });
  }
  catch (error) { if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE')) reject(409, '存在未核对操作，请先查看操作历史；不会重复提交。'); throw error; }
  const context = generationContext.getStore() ?? {};
  const signal = options.signal ?? context.signal, directory = options.directory ?? mediaDirectory;
  const validate = options.validate ?? validateMediaFile;
  return withRunning(db, id, async () => {
    let file;
    try {
      context.progress?.({ type: 'operation', operationId: id });
      file = await createMediaFile(id, directory);
      const response = await ironRequest(config, endpoint, { body, signal });
      const meta = await receiveMixed(response, { sink: file.sink, expected, onEvent: async event => {
        const fields = { event_json: JSON.stringify(event), ...(event.type === 'accepted' ? { accepted_json: JSON.stringify(event) } : {}), task_id: event.task_id, task_state: event.state, local_state: event.state === 'delivering' ? 'receiving' : 'accepted' };
        if (event.type === 'output_begin') fields.metadata_json = JSON.stringify(event);
        if (event.type === 'transfer_error') {
          const previous = readOperation(db, id, projectId).metadata_json;
          const fixed = Object.fromEntries(['bytes', 'sha256', 'delivery_ready_at', 'delivery_expires_at', 'delivery_timeout_ms'].map(key => [key, event[key]]));
          fields.metadata_json = JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), ...fixed });
        }
        update(db, id, fields);
        context.progress?.({ type: 'progress', operationId: id, event: { type: event.type, state: event.state, progress: event.progress } });
      } });
      await file.file.sync();
      await validate(file.filename, meta);
      await publishMedia(id, file.file, directory); file = null;
      // rename 先于 SQLite 提交；崩溃时只按操作 ID 对账，不删除已发布文件。
      inTransaction(db, () => update(db, id, { metadata_json: JSON.stringify(meta), local_state: 'saved', active: 0, error: '' }));
      return await confirm(db, readOperation(db, id, projectId), config, signal);
    } catch (error) {
      if (file) await file.file.close().catch(() => {});
      const row = readOperation(db, id, projectId);
      if (!row.task_id && error.upstreamRejected) {
        update(db, id, { local_state: 'rejected', active: 0, error: `生成请求未受理（HTTP ${error.upstreamStatus}：${error.code}）；未自动重新生成，可修改后手动发起新请求。` });
      } else update(db, id, { local_state: 'interrupted', active: ['failed', 'cancelled'].includes(row.task_state) ? 0 : 1,
        error: row.task_id ? `接收或持久化中断，请恢复同一操作；未自动重新生成。${error.status === 503 ? ' 请检查可配置媒体解码工具和存储状态。' : ''}` : '提交结果未知，禁止自动再次 POST；请先核对服务端记录。' });
      throw Object.assign(new Error(readOperation(db, id, projectId).error), { status: error.status ?? 502, operationId: id });
    }
  });
}
export async function recoverOperation(db, projectId, id, options = {}) {
  return withRunning(db, id, async () => {
    let row = readOperation(db, id, projectId);
    if (row.local_state === 'confirmed') return publicOperation(row);
    if (row.local_state === 'rejected') reject(409, row.error);
    if (!row.task_id) reject(409, '尚无持久关联的任务编号，不能猜任务或再次推理；请核对服务端记录。');
    generationContext.getStore()?.progress?.({ type: 'operation', operationId: id });
    const config = configFor(db, row), expected = JSON.parse(row.request_json).expected;
    let meta = row.metadata_json ? JSON.parse(row.metadata_json) : null;
    const directory = options.directory ?? mediaDirectory, validate = options.validate ?? validateMediaFile, signal = options.signal ?? generationContext.getStore()?.signal;
    let file;
    try {
      const final = mediaPath(id, false, directory), part = mediaPath(id, true, directory);
      let finalValid = false;
      if (meta?.mime_type) {
        try { await verifyFile(final, meta); if (row.local_state !== 'saved') await validate(final, meta); finalValid = true; }
        catch (error) { if (error.code !== 'ENOENT' && error.status !== 502) throw error; }
      }
      if (finalValid && row.local_state === 'saved') return await confirm(db, row, config, signal);
      // rename 可早于目录 fsync 失败；不能因文件可见就跳过持久化保障。
      if (finalValid) await syncPublishedMedia(id, directory);
      else {
        let complete = false;
        try { if (!meta?.mime_type) throw new Error('尚无完整媒体元数据。'); await verifyFile(part, meta); await validate(part, meta); complete = true; } catch { /* 残片只允许完整校验后发布，否则整取。 */ }
        if (complete) {
          const { open } = await import('node:fs/promises'); await publishMedia(id, await open(part, 'r+'), directory);
        } else {
          file = await createMediaFile(id, directory);
          meta = await fetchOutput(config, row.task_id, meta, { sink: file.sink, signal, expected, onMetadata: async value => update(db, id, { metadata_json: JSON.stringify(value), task_state: 'delivering' }) });
          await file.file.sync(); await validate(file.filename, meta); await publishMedia(id, file.file, directory); file = null;
        }
      }
      inTransaction(db, () => update(db, id, { metadata_json: JSON.stringify(meta), local_state: 'saved', active: 0, error: '' }));
      row = readOperation(db, id, projectId); return await confirm(db, row, config, signal);
    } catch (error) {
      if (error.upstreamStatus) update(db, id, { error: error.message,
        ...(error.upstreamRejected && error.code === 'delivery_expired' ? { task_state: 'failed', active: 0 } : {}) });
      throw error;
    } finally { if (file) await file.file.close().catch(() => {}); }
  });
}
export function releaseOperation(db, projectId, id) {
  const row = readOperation(db, id, projectId);
  if (running.get(db)?.has(id)) reject(409, '请先停止当前传输。');
  update(db, id, { active: 0 });
  return { ...publicOperation(row), active: false, message: '仅解除本地防重锁；不宣称远端取消，不删除历史或本地文件。再次生成是新任务，可能重复计费。' };
}

// 恢复可能处理已解除 active 的记录；它仍在收文件时不能删除整个项目。
export function assertProjectOperationsIdle(db, projectId) {
  const active = running.get(db);
  if (active && db.prepare('SELECT id FROM generation_operations WHERE project_id=?').all(projectId).some(row => active.has(row.id))) reject(409, '项目仍在接收或核对生成操作，请先停止当前传输。');
}
