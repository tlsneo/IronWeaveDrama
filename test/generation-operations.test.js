import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { openDatabase } from '../src/database.js';
import { readApiConfig } from '../src/settings.js';
import { generateOperation, recoverOperation, listOperations, releaseOperation, generationContext } from '../src/generation-operations.js';
import { mediaPath } from '../src/media-files.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drama-d1-'));
  let db = openDatabase(join(directory, 'test.sqlite'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const data = Buffer.from('synthetic transport fixture; decoder is a separately tested boundary');
  const task = '965375ee-5e5a-46bb-b187-23f779f3ddc1', boundary = 'iw_' + 'c'.repeat(32);
  const meta = { mime_type: 'image/png', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), width: 16, height: 9, delivery_ready_at: new Date().toISOString(), delivery_timeout_ms: 1800000 };
  meta.delivery_expires_at = new Date(Date.parse(meta.delivery_ready_at) + 1800000).toISOString();
  const stats = { post: 0, ack: 0, get: 0 }, control = { truncate: false, ackLost: false, acceptedLost: false, boundaryCollision: false };
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/ack')) {
      stats.ack++;
      const row = db.prepare('SELECT * FROM generation_operations WHERE task_id=?').get(task);
      assert.ok(['saved', 'confirmed'].includes(row.local_state)); assert.deepEqual(await readFile(mediaPath(row.id, false, directory)), data);
      if (control.ackLost) { res.destroy(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ task_id: task, state: 'succeeded', bytes: meta.bytes, sha256: meta.sha256 })); return;
    }
    if (req.url.endsWith('/output')) {
      stats.get++; res.writeHead(200, { 'Content-Type': meta.mime_type, 'Content-Length': meta.bytes, 'X-IronWeave-Protocol': '2', 'X-IronWeave-Task-ID': task, 'X-IronWeave-Sha256': meta.sha256, 'X-IronWeave-Delivery-Expires-At': meta.delivery_expires_at, 'Accept-Ranges': 'none' }); res.end(data); return;
    }
    stats.post++;
    if (control.acceptedLost) { res.destroy(); return; }
    res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol': '2' });
    const event = (type, seq, extra) => { const value = Buffer.from(JSON.stringify({ task_id: task, seq, type, state: type === 'accepted' ? 'accepted' : 'delivering', ...extra })); res.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${value.length}\r\n\r\n`); res.write(value); res.write('\r\n'); };
    event('accepted', 1, { seed: 1, workflow_version: 'synthetic' });
    if (control.acceptedOnly) { setTimeout(() => res.destroy(), 20); return; }
    if (control.boundaryCollision) { const { bytes, sha256, delivery_ready_at, delivery_expires_at, delivery_timeout_ms } = meta; event('transfer_error', 2, { bytes, sha256, delivery_ready_at, delivery_expires_at, delivery_timeout_ms, error: { code: 'boundary_collision', message: 'fixture', phase: 'output' } }); res.end(`--${boundary}--\r\n`); return; }
    event('output_begin', 2, meta);
    res.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${data.length}\r\n\r\n`);
    if (control.truncate) { res.write(data.subarray(0, 5)); setTimeout(() => res.destroy(), 20); return; }
    res.write(data); res.write('\r\n');
    if (control.outputError) { const { bytes, sha256, delivery_ready_at, delivery_expires_at, delivery_timeout_ms } = meta; event('transfer_error', 3, { mime_type: 'unknown-extension-must-not-replace-fixed-metadata', bytes, sha256, delivery_ready_at, delivery_expires_at, delivery_timeout_ms, error: { code: 'output_transfer_failed', message: 'fixture', phase: 'output' } }); }
    else event('output_end', 3, meta); res.end(`--${boundary}--\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  db.prepare("INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES('合成','text_to_image',?,'synthetic-key','ironweave')").run(`http://127.0.0.1:${server.address().port}`);
  db.exec("INSERT INTO api_protocols(config_id,protocol) VALUES(1,'ironweave2'); INSERT INTO projects VALUES(1,'隔离项目','水墨','16:9')");
  const config = readApiConfig(db, 1), options = { directory, validate: async (_file, metadata) => { assert.equal(metadata.bytes, data.length); } };
  const generate = () => generateOperation(db, { projectId: 1, kind: 'scene', targetId: 1, config, source: { revision: 'immutable-source' }, endpoint: '/images/generations', body: { model: 'ironweave', prompt: 'synthetic', size: '16x9' }, expected: { size: '16x9' } }, options);
  return { get db() { return db; }, restartDatabase() { db.close(); db = openDatabase(join(directory, 'test.sqlite')); }, directory, stats, control, options, generate, meta };
}
test('accepted 立刻持久关联，完整发布和 SQLite 关联后才 ACK，正常 EOF 不取消', async t => {
  const f = await fixture(t), seen = [];
  const op = await generationContext.run({ progress(event) { seen.push(event.type); if (event.event?.type === 'accepted') assert.ok(f.db.prepare('SELECT task_id FROM generation_operations').get().task_id); } }, f.generate);
  assert.equal(op.deliveryConfirmed, true); assert.equal(op.taskState, 'succeeded'); assert.equal(op.adopted, false); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 0 }); assert.ok(seen.includes('operation'));
  assert.equal(f.db.prepare('SELECT source_json FROM generation_operations').get().source_json, '{"revision":"immutable-source"}');
});
test('ACK 响应丢失保留本地完整文件，同一回执恢复不 GET、不 POST、不按到期误判失败', async t => {
  const f = await fixture(t); f.control.ackLost = true; const op = await f.generate();
  assert.equal(op.localState, 'saved'); assert.equal(op.deliveryConfirmed, false);
  f.control.ackLost = false;
  const expired = { ...f.meta, delivery_ready_at: '2000-01-01T00:00:00.000Z', delivery_expires_at: '2000-01-01T00:30:00.000Z' };
  f.db.prepare('UPDATE generation_operations SET metadata_json=? WHERE id=?').run(JSON.stringify(expired), op.id);
  const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 2, get: 0 });
});
test('媒体截断不 ACK；恢复从新临时文件整取同一哈希并确认，不新建任务', async t => {
  const f = await fixture(t); f.control.truncate = true; await assert.rejects(f.generate());
  const op = listOperations(f.db, 1)[0]; assert.equal(op.taskState, 'delivering'); assert.equal(f.stats.ack, 0);
  await assert.rejects(f.generate(), { status: 409 });
  const result = await recoverOperation(f.db, 1, op.id, f.options); assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 1 });
});
test('边界碰撞 transfer_error 的固定回执可以整取同一产物', async t => {
  const f = await fixture(t); f.control.boundaryCollision = true; await assert.rejects(f.generate());
  const op = listOperations(f.db, 1)[0]; const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 1 });
});
test('accepted 丢失保留提交未知，重复点击和恢复都不再次 POST', async t => {
  const f = await fixture(t); f.control.acceptedLost = true; await assert.rejects(f.generate());
  await assert.rejects(f.generate(), { status: 409 }); const op = listOperations(f.db, 1)[0];
  assert.equal(op.taskId, null); await assert.rejects(recoverOperation(f.db, 1, op.id, f.options), { status: 409 }); assert.equal(f.stats.post, 1);
});
test('文件已 rename 而 SQLite 保存失败不 ACK；解除存储故障后按操作对账，不扫描目录、不重新生成', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_media_save BEFORE UPDATE OF local_state ON generation_operations WHEN NEW.local_state='saved' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  await assert.rejects(f.generate()); assert.equal(f.stats.ack, 0); const op = listOperations(f.db, 1)[0];
  assert.ok((await readFile(mediaPath(op.id, false, f.directory))).length);
  f.db.exec('DROP TRIGGER fail_media_save'); const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 0 });
});
test('完整解码失败不能 ACK，改变认证身份不能核对其他任务', async t => {
  const f = await fixture(t); f.options.validate = async () => { throw new Error('synthetic decode failure'); };
  await assert.rejects(f.generate()); assert.equal(f.stats.ack, 0); const op = listOperations(f.db, 1)[0];
  f.db.exec("UPDATE api_configs SET api_key='different-synthetic-key'"); await assert.rejects(recoverOperation(f.db, 1, op.id, f.options), { status: 409 });
});

test('accepted 已保存但 output_begin 丢失，凭同一任务 GET 的权威头恢复，不重新生成', async t => {
  const f = await fixture(t); f.control.acceptedOnly = true; await assert.rejects(f.generate());
  const op = listOperations(f.db, 1)[0]; assert.ok(op.taskId); assert.equal(op.metadata, null);
  const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 1 });
});

test('schema17 增量升级保留旧 BLOB，不要求迁移或扫描媒体目录，失败整组回滚', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-schema17-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'legacy.sqlite'); let db = openDatabase(filename);
  db.exec("INSERT INTO projects VALUES(1,'旧项目','写实','16:9'); INSERT INTO scenes(id,project_id,name) VALUES(1,1,'旧场景'); INSERT INTO scene_images(scene_id,image,mime,width,height,valid,revision,model,prompt) VALUES(1,x'010203','image/png',1,1,1,'old','legacy','unchanged'); DROP TABLE generated_media_links; DROP TABLE generation_operations; DROP TABLE video_clips; DROP TABLE api_protocols; PRAGMA user_version=16");
  db.close();
  const { DatabaseSync } = await import('node:sqlite'), original = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) { const result = original.call(this, sql); if (sql.includes('PRAGMA user_version = 17')) throw new Error('synthetic migration17 failure'); return result; });
  assert.throws(() => openDatabase(filename), /migration17 failure/); t.mock.restoreAll();
  db = new DatabaseSync(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='generation_operations'").get(), undefined); db.close();
  db = openDatabase(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 18); assert.deepEqual(Buffer.from(db.prepare('SELECT image FROM scene_images').get().image), Buffer.from([1,2,3])); assert.equal(db.prepare('SELECT count(*) AS n FROM generation_operations').get().n, 0); db.close();
});

test('已保存文件恢复不再写入 saved，额外保存写入失败仍可核对固定 ACK', async t => {
  const f = await fixture(t); f.control.ackLost = true; const op = await f.generate();
  f.control.ackLost = false;
  f.db.exec("CREATE TRIGGER refuse_resave BEFORE UPDATE OF local_state ON generation_operations WHEN NEW.local_state='saved' BEGIN SELECT RAISE(ABORT,'no redundant save'); END");
  const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 2, get: 0 });
});

test('已保存文件损坏时重取同一产物，不能 ACK 损坏文件或重新生成', async t => {
  const f = await fixture(t); f.control.ackLost = true; const op = await f.generate();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(mediaPath(op.id, false, f.directory), Buffer.from('damaged'));
  f.control.ackLost = false;
  const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 2, get: 1 });
});

test('rename 后目录刷盘失败，恢复须再次刷盘成功后才能 ACK', async t => {
  const f = await fixture(t);
  const { open } = await import('node:fs/promises');
  const handle = await open(f.directory, 'r'), proto = Object.getPrototypeOf(handle), sync = proto.sync;
  await handle.close();
  let directorySyncs = 0, broken = true;
  t.mock.method(proto, 'sync', async function() {
    if ((await this.stat()).isDirectory()) { directorySyncs++; if (broken) throw new Error('synthetic directory fsync failure'); }
    return sync.call(this);
  });
  await assert.rejects(f.generate()); const op = listOperations(f.db, 1)[0];
  await assert.rejects(recoverOperation(f.db, 1, op.id, f.options)); assert.equal(f.stats.ack, 0);
  broken = false; const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.ok(directorySyncs >= 3); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 0 });
});


test('媒体后 transfer_error 不丢 output_begin 技术属性，完整残片过期后仍可核对 ACK', async t => {
  const f = await fixture(t); f.control.outputError = true; await assert.rejects(f.generate());
  const op = listOperations(f.db, 1)[0]; assert.equal(op.metadata.mime_type, 'image/png');
  const expired = { ...op.metadata, delivery_ready_at: '2000-01-01T00:00:00.000Z', delivery_expires_at: '2000-01-01T00:30:00.000Z' };
  f.db.prepare('UPDATE generation_operations SET metadata_json=? WHERE id=?').run(JSON.stringify(expired), op.id);
  const result = await recoverOperation(f.db, 1, op.id, f.options);
  assert.equal(result.deliveryConfirmed, true); assert.deepEqual(f.stats, { post: 1, ack: 1, get: 0 });
});


test('正在接收时不能解锁；中断后明确释放只改本地防重，不取消或补发 POST', async t => {
  const f = await fixture(t); f.control.acceptedOnly = true;
  await assert.rejects(generationContext.run({ progress(event) {
    if (event.type === 'operation') assert.throws(() => releaseOperation(f.db, 1, event.operationId), { status: 409 });
  } }, f.generate));
  const op = listOperations(f.db, 1)[0]; assert.equal(op.active, true);
  const result = releaseOperation(f.db, 1, op.id);
  assert.equal(result.active, false); assert.equal(result.taskState, op.taskState);
  assert.equal(listOperations(f.db, 1)[0].active, false); assert.deepEqual(f.stats, { post: 1, ack: 0, get: 0 });
});


test('实际关闭并重开 SQLite 后，完整保存只核对 ACK、残片只 GET 同任务', async t => {
  for (const saved of [true, false]) {
    const f = await fixture(t);
    if (saved) { f.control.ackLost = true; await f.generate(); f.control.ackLost = false; }
    else { f.control.truncate = true; await assert.rejects(f.generate()); }
    const before = listOperations(f.db, 1)[0]; f.restartDatabase();
    const result = await recoverOperation(f.db, 1, before.id, f.options);
    assert.equal(result.taskId, before.taskId); assert.equal(result.deliveryConfirmed, true);
    assert.deepEqual(f.stats, { post: 1, ack: saved ? 2 : 1, get: saved ? 0 : 1 });
  }
});


test('A: ACK 丢失不能删项目，保持原记录后真实恢复同回执，确认后才登记项目文件清理', async t => {
  const { deleteItem } = await import('../src/deletion.js');
  const f = await fixture(t); f.control.ackLost = true; const op = await f.generate();
  const form = new URLSearchParams({ confirmed: 'yes', name: '隔离项目' });
  assert.throws(() => deleteItem(f.db, 'projects', 1, undefined, form), { status: 409 });
  f.control.ackLost = false; await recoverOperation(f.db, 1, op.id, f.options);
  assert.deepEqual(f.stats, { post: 1, ack: 2, get: 0 });
  deleteItem(f.db, 'projects', 1, undefined, form);
  assert.equal(f.db.prepare('SELECT operation_id FROM media_cleanup').get().operation_id, op.id);
  assert.equal(f.db.prepare('SELECT id FROM generation_operations').get(), undefined);
});


test('A: 已 release 的 accepted 操作正在恢复时不能删项目；项目删除后不再插入孤儿操作/POST', async t => {
  const { deleteItem } = await import('../src/deletion.js');
  const f = await fixture(t); f.control.acceptedOnly = true; await assert.rejects(f.generate());
  const op = listOperations(f.db, 1)[0]; releaseOperation(f.db, 1, op.id);
  await generationContext.run({ progress(event) {
    if (event.type === 'operation') assert.throws(() => deleteItem(f.db, 'projects', 1, undefined, new URLSearchParams({ confirmed: 'yes', name: '隔离项目' })), { status: 409 });
  } }, () => recoverOperation(f.db, 1, op.id, f.options));
  deleteItem(f.db, 'projects', 1, undefined, new URLSearchParams({ confirmed: 'yes', name: '隔离项目' }));
  await assert.rejects(f.generate(), { status: 404 });
  assert.deepEqual(f.stats, { post: 1, ack: 1, get: 1 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM generation_operations').get().n, 0);
});
