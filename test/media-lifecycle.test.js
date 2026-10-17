import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = await mkdtemp(join(tmpdir(), 'drama-lifecycle-'));
process.env.IRONWEAVE_DRAMA_MEDIA_DIR = join(root, 'media');
after(() => rm(root, { recursive: true, force: true }));
const { openDatabase } = await import('../src/database.js');
const { deleteItem } = await import('../src/deletion.js');
const { createApp } = await import('../src/app.js');
const { mediaPath, mediaDirectory } = await import('../src/media-files.js');
const { resourceRevision } = await import('../src/resource-images.js');
const { releaseOperation } = await import('../src/generation-operations.js');
const confirmed = name => new URLSearchParams({ confirmed: 'yes', name });
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

async function fixture(t) {
  const filename = join(root, `${randomUUID()}.sqlite`); let db = openDatabase(filename), server;
  db.exec("INSERT INTO projects VALUES(1,'project','style','16:9'),(2,'other','style','16:9'); INSERT INTO scenes(id,project_id,name) VALUES(1,1,'scene'),(2,2,'other scene'); INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES('synthetic','text_to_image','http://127.0.0.1:1','synthetic-key','ironweave'); INSERT INTO api_protocols(config_id,protocol) VALUES(1,'ironweave2'); INSERT INTO scene_images(scene_id,image,mime,width,height,valid,revision,model,prompt) VALUES(2,x'010203','image/png',1,1,1,'legacy','legacy','unchanged')");
  await mkdir(mediaDirectory, { recursive: true });
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); else db.close(); });
  async function operation({ projectId = 1, ack = true } = {}) {
    const id = randomUUID(), data = Buffer.from('synthetic persisted media');
    const source = { revision: resourceRevision('scene', db.prepare('SELECT * FROM scenes WHERE id=?').get(projectId), db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)), referenceId: null, model: 'ironweave', prompt: 'fixture' };
    const meta = { mime_type: 'image/png', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), width: 16, height: 9 };
    db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,metadata_json,task_id,task_state,local_state,active,adopted,ack_json) VALUES(?,?,'scene',?,1,'{}',?,'{}',?,?,?,?,0,1,?)").run(id, projectId, projectId, JSON.stringify(source), JSON.stringify(meta), randomUUID(), ack ? 'succeeded' : 'delivering', ack ? 'confirmed' : 'saved', ack ? '{}' : null);
    const imageId = db.prepare("INSERT INTO scene_images(scene_id,image,mime,width,height,valid,revision,model,prompt) VALUES(?,x'','image/png',16,9,1,?,'ironweave','fixture')").run(projectId, source.revision).lastInsertRowid;
    db.prepare("INSERT INTO generated_media_links VALUES('scene_images',?,?)").run(imageId, id);
    await writeFile(mediaPath(id), data); await writeFile(mediaPath(id, true), 'synthetic partial');
    return id;
  }
  return { get db() { return db; }, filename, operation, restart() { db.close(); db = openDatabase(filename); }, async app() { server = createApp(db); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; } };
}

test('A: ACK 未确认项目拒绝删除，明确 release 也不伪造确认，历史与恢复入口仍可达', async t => {
  const f = await fixture(t), id = await f.operation({ ack: false }), url = await f.app();
  releaseOperation(f.db, 1, id);
  const response = await fetch(`${url}/projects/1/delete`, { method: 'POST', body: confirmed('project') });
  assert.equal(response.status, 409);
  assert.equal((await fetch(`${url}/projects/1/operations`)).status, 200);
  // 故意不匹配保存身份：409 来自恢复校验，而非项目被删后的404；不会发网络请求。
  assert.equal((await fetch(`${url}/projects/1/operations/${id}/recover`, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes' }) })).status, 409);
  assert.equal(count(f.db, 'generation_operations'), 1); assert.equal(count(f.db, 'media_cleanup'), 0);
  f.db.prepare("UPDATE generation_operations SET ack_json='{}',task_state='succeeded',local_state='confirmed' WHERE id=?").run(id);
  const deleted = await (await fetch(`${url}/projects/1/delete`, { method: 'POST', body: confirmed('project') })).json();
  assert.equal(deleted.mediaCleanupPending, false); assert.match(deleted.message, /所属新媒体已清理/);
  await assert.rejects(stat(mediaPath(id)), { code: 'ENOENT' }); assert.equal(count(f.db, 'media_cleanup'), 0);
});

test('A: 项目删除事务登记 UUID 清理待办并删除新关联，提交前后都不在事务内删文件', async t => {
  const f = await fixture(t), id = await f.operation();
  f.db.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  assert.throws(() => deleteItem(f.db, 'projects', 1, undefined, confirmed('project')), /synthetic rollback/);
  assert.equal(count(f.db, 'generation_operations'), 1); assert.equal(count(f.db, 'generated_media_links'), 1); assert.equal(count(f.db, 'media_cleanup'), 0);
  assert.ok((await stat(mediaPath(id))).size);
  f.db.exec('DROP TRIGGER fail_project_delete');
  deleteItem(f.db, 'projects', 1, undefined, confirmed('project'));
  assert.equal(count(f.db, 'generation_operations'), 0); assert.equal(count(f.db, 'generated_media_links'), 0);
  assert.equal(f.db.prepare('SELECT operation_id FROM media_cleanup').get().operation_id, id);
  assert.ok((await stat(mediaPath(id))).size);
});

test('A: 清理失败保留待办，SQLite重开后幂等重试；不扫描未登记文件或其他项目', async t => {
  const { cleanupPendingMedia } = await import('../src/media-cleanup.js');
  const f = await fixture(t), id = await f.operation(), other = await f.operation({ projectId: 2 }), unowned = randomUUID();
  await writeFile(mediaPath(unowned), 'unregistered: never scan');
  deleteItem(f.db, 'projects', 1, undefined, confirmed('project'));
  // 目录占位使 unlink 确定失败；不能使用递归 rm 绕过文件安全边界。
  await rm(mediaPath(id)); await mkdir(mediaPath(id));
  assert.deepEqual(await cleanupPendingMedia(f.db, { directory: mediaDirectory, projectId: 1 }), { completed: 0, pending: 1 });
  assert.match(f.db.prepare('SELECT last_error FROM media_cleanup').get().last_error, /待重试/);
  f.restart(); assert.equal(count(f.db, 'media_cleanup'), 1);
  await rm(mediaPath(id), { recursive: true }); await writeFile(mediaPath(id), 'owned replacement fixture');
  assert.deepEqual(await cleanupPendingMedia(f.db, { directory: mediaDirectory }), { completed: 1, pending: 0 });
  assert.deepEqual(await cleanupPendingMedia(f.db, { directory: mediaDirectory }), { completed: 0, pending: 0 });
  for (const temporary of [true, false]) await assert.rejects(stat(mediaPath(id, temporary)), { code: 'ENOENT' });
  assert.equal(await readFile(mediaPath(unowned), 'utf8'), 'unregistered: never scan');
  assert.ok((await stat(mediaPath(other))).size);
  assert.deepEqual(Buffer.from(f.db.prepare("SELECT image FROM scene_images WHERE revision='legacy'").get().image), Buffer.from([1,2,3]));
  assert.equal(count(f.db, 'generation_operations'), 1); assert.equal(count(f.db, 'generated_media_links'), 1);
  assert.equal(deleteItem(f.db, 'api_configs', 1, undefined, confirmed('synthetic')).deleted, true);
});

test('A: HTTP 删除提交后清理失败仍报告已删且待重试，清理成功不留悬空配置锁', async t => {
  const f = await fixture(t), id = await f.operation(), url = await f.app();
  await rm(mediaPath(id)); await mkdir(mediaPath(id));
  const response = await fetch(`${url}/projects/1/delete`, { method: 'POST', body: confirmed('project') });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.deleted, true); assert.equal(result.mediaCleanupPending, true); assert.match(result.message, /项目已删除，媒体清理待重试/);
  assert.equal(count(f.db, 'media_cleanup'), 1); assert.equal(count(f.db, 'generation_operations'), 0);
  assert.equal((await fetch(`${url}/settings/api/1/delete`, { method: 'POST', body: confirmed('synthetic') })).status, 200);
});

test('A: 有界清理禁止在事务内执行，坏UUID保留待办而不删除任意路径', async t => {
  const { cleanupPendingMedia } = await import('../src/media-cleanup.js');
  const f = await fixture(t), a = await f.operation(), b = await f.operation();
  deleteItem(f.db, 'projects', 1, undefined, confirmed('project'));
  f.db.exec('BEGIN IMMEDIATE');
  await assert.rejects(cleanupPendingMedia(f.db), /事务提交后/); f.db.exec('ROLLBACK');
  assert.ok((await stat(mediaPath(a))).size); assert.ok((await stat(mediaPath(b))).size);
  assert.deepEqual(await cleanupPendingMedia(f.db, { limit: 1 }), { completed: 1, pending: 1 });
  await cleanupPendingMedia(f.db);
  f.db.prepare('INSERT INTO media_cleanup(operation_id,project_id) VALUES(?,1)').run('../not-a-uuid');
  assert.deepEqual(await cleanupPendingMedia(f.db), { completed: 0, pending: 1 });
});

test('A/B: 资源删除保留项目历史、播放文件与交付记录，移除悬空链接并标记来源已删除', async t => {
  const { sourceStatus } = await import('../src/generation-source.js');
  const f = await fixture(t), id = await f.operation({ ack: false }), url = await f.app();
  const response = await fetch(`${url}/projects/1/scenes/1/delete`, { method: 'POST', body: confirmed('scene') });
  assert.equal(response.status, 200); assert.match((await response.json()).message, /历史.*保留/);
  assert.equal(count(f.db, 'generated_media_links'), 0); assert.equal(count(f.db, 'media_cleanup'), 0);
  const row = f.db.prepare('SELECT * FROM generation_operations WHERE id=?').get(id);
  assert.equal(row.task_state, 'delivering'); assert.equal(sourceStatus(f.db, row).state, 'deleted');
  assert.equal((await fetch(`${url}/projects/1/operations/${id}/media`)).status, 200);
  const history = await (await fetch(`${url}/projects/1/operations`)).text();
  assert.match(history, /来源已删除/); assert.match(history, /曾采用，当前已失效/); assert.match(history, /恢复 \/ 核对同一回执/);
  assert.equal((await fetch(`${url}/projects/1/operations/${id}/adopt`, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes' }) })).status, 409);
});

for (const version of [16, 17]) test(`A: 实际${version}→18升级及失败回滚保持旧BLOB/来源记录`, async t => {
  const f = await fixture(t); await f.operation();
  f.db.exec('DROP TABLE media_cleanup');
  if (version === 16) f.db.exec('DROP TABLE generated_media_links; DROP TABLE generation_operations; DROP TABLE video_clips; DROP TABLE api_protocols');
  f.db.exec(`PRAGMA user_version=${version}`);
  const before = f.db.prepare('SELECT * FROM scene_images ORDER BY id').all();
  const schema = f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 18')) throw new Error('synthetic migration18 failure'); return result; });
  assert.throws(() => openDatabase(f.filename), /migration18 failure/); t.mock.restoreAll();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, version);
  assert.deepEqual(f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM scene_images ORDER BY id').all(), before);
  f.restart(); assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 18);
  assert.deepEqual(f.db.prepare('SELECT * FROM scene_images ORDER BY id').all(), before);
  assert.equal(count(f.db, 'media_cleanup'), 0);
  assert.equal(count(f.db, 'generation_operations'), version === 17 ? 1 : 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});


test('A: 文件已删除但待办完成提交失败，重试以ENOENT幂等完成，不丢清理意图', async t => {
  const { cleanupPendingMedia } = await import('../src/media-cleanup.js');
  const f = await fixture(t), id = await f.operation();
  deleteItem(f.db, 'projects', 1, undefined, confirmed('project'));
  f.db.exec("CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON media_cleanup BEGIN SELECT RAISE(ABORT,'synthetic queue write failure'); END");
  assert.deepEqual(await cleanupPendingMedia(f.db), { completed: 0, pending: 1 });
  await assert.rejects(stat(mediaPath(id)), { code: 'ENOENT' });
  f.db.exec('DROP TRIGGER fail_cleanup_commit'); f.restart();
  assert.deepEqual(await cleanupPendingMedia(f.db), { completed: 1, pending: 0 });
});
