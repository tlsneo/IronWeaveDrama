import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'drama-generation-http-'));
process.env.IRONWEAVE_DRAMA_MEDIA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const { openDatabase } = await import('../src/database.js');
const { createApp } = await import('../src/app.js');
const { resourceRevision } = await import('../src/resource-images.js');
const { mediaPath } = await import('../src/media-files.js');
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }; }
async function fixture(t, mode) {
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO projects VALUES(1,'项目','水墨','16:9'),(2,'其他项目','写实','1:1'); INSERT INTO scenes(id,project_id,name,description) VALUES(1,1,'房间','窗户在左')");
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; }); let posts = 0;
  const provider = await listen(createServer(async (req, res) => {
    for await (const _ of req) {}
    posts++;
    const boundary = 'iw_' + 'd'.repeat(32), task = randomUUID();
    res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol': '2' });
    const event = value => { const bytes = Buffer.from(JSON.stringify(value)); res.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`); res.write(bytes); res.write('\r\n'); };
    event({ type: 'accepted', task_id: task, seq: 1, state: 'accepted', seed: 1, workflow_version: 'synthetic' });
    if (mode === 'end') { event({ type: 'error', task_id: task, seq: 2, state: 'failed', error: { code: 'runtime_failed', message: 'synthetic', phase: 'running' } }); res.end(`--${boundary}--\r\n`); }
    else { const timer = setInterval(() => event({ type: 'heartbeat', task_id: task, seq: 2, state: 'accepted' }), 1000); res.on('close', () => { clearInterval(timer); resolveClosed(); }); }
  })); t.after(provider.close);
  db.prepare("INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES('合成','text_to_image',?,'synthetic-key','ironweave')").run(provider.url);
  db.exec("INSERT INTO api_protocols(config_id,protocol) VALUES(1,'ironweave2')");
  const app = await listen(createApp(db)); t.after(app.close);
  const source = resourceRevision('scene', db.prepare('SELECT * FROM scenes WHERE id=1').get(), db.prepare('SELECT * FROM projects WHERE id=1').get());
  const body = () => new URLSearchParams({ apiConfigId: '1', chargeConfirmed: 'yes', revision: source, model: 'ironweave', baseUrl: provider.url, referenceId: '' });
  return { db, app, body, source, closed, calls: () => posts };
}
test('显式 NDJSON 包含操作、真实 accepted 与最终业务错误；普通 CRUD 保持 JSON', async t => {
  const f = await fixture(t, 'end');
  const response = await fetch(f.app.url + '/projects/1/scenes/1/generate', { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: f.body() });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'operation'); assert.equal(events[1].event.type, 'accepted'); assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).status, 502);
  const row = f.db.prepare('SELECT * FROM generation_operations').get(); assert.equal(row.task_state, 'failed'); assert.equal(row.active, 0); assert.equal(f.calls(), 1);
  const crud = await fetch(f.app.url + '/projects/1/scenes/1', { method: 'POST', body: new URLSearchParams({ name: '房间', description: '右侧窗户' }) }); assert.match(crud.headers.get('content-type'), /application\/json/);
});
test('浏览器异常断流中止上游；正常收到 accepted 不因已读完请求正文被误取消', async t => {
  const f = await fixture(t, 'wait');
  const response = await fetch(f.app.url + '/projects/1/scenes/1/generate', { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: f.body() });
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('accepted')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(f.db.prepare('SELECT task_id FROM generation_operations').get().task_id);
  await reader.cancel(); await Promise.race([f.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('上游未中止')), 2000))]);
  assert.equal(f.calls(), 1);
});
test('完整未确认文件可人工采用；历史不自动采用，旧依据拒绝，旧 BLOB 与新文件 GET/HEAD 共存', async t => {
  const f = await fixture(t, 'end'), id = randomUUID(), bytes = Buffer.from('controlled saved image');
  const meta = { mime_type: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 9 };
  await writeFile(mediaPath(id), bytes);
  f.db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,metadata_json,task_state,local_state,active) VALUES(?,1,'scene',1,1,'{}',?,'{}',?,'delivering','saved',0)").run(id, JSON.stringify({ revision: f.source, referenceId: null, model: 'ironweave', prompt: 'controlled source' }), JSON.stringify(meta));
  const base = f.app.url + `/projects/1/operations/${id}`;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scene_images').get().n, 0);
  const history = await (await fetch(f.app.url + '/projects/1/operations')).text(); assert.match(history, /交付确认未确定/);
  assert.equal((await fetch(f.app.url + `/projects/2/operations/${id}/media`)).status, 404);
  f.db.exec("UPDATE scenes SET description='changed' WHERE id=1");
  assert.equal((await fetch(base + '/adopt', { method: 'POST', body: new URLSearchParams({ confirmed: 'yes' }) })).status, 409);
  f.db.exec("UPDATE scenes SET description='窗户在左' WHERE id=1");
  const adopted = await (await fetch(base + '/adopt', { method: 'POST', body: new URLSearchParams({ confirmed: 'yes' }) })).json(); assert.equal(adopted.adopted, true); assert.equal(adopted.deliveryConfirmed, false);
  const imageUrl = f.app.url + `/projects/1/scenes/1/images/${adopted.imageId}`;
  assert.deepEqual(Buffer.from(await (await fetch(imageUrl)).arrayBuffer()), bytes); assert.equal(await (await fetch(imageUrl, { method: 'HEAD' })).text(), '');
  const old = f.db.prepare("INSERT INTO scene_images(scene_id,image,mime,width,height,valid,revision,model,prompt) VALUES(1,?,'image/png',1,1,0,'old','old','old')").run(Buffer.from('old blob')).lastInsertRowid;
  assert.equal(await (await fetch(f.app.url + `/projects/1/scenes/1/images/${old}`)).text(), 'old blob');
  assert.equal(f.calls(), 0);
});
