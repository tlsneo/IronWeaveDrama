import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { characterRevision } from '../src/character-images.js';
import { imageDetails, loadImage } from '../src/images.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';

function png(width = 16, height = 9) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(body.length + 8);
    output.writeUInt32BE(data.length);
    body.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

async function fixture(t, filename = ':memory:') {
  const database = openDatabase(filename);
  database.exec("INSERT INTO projects VALUES (1, '原项目', '国风水墨', '9:16'); INSERT INTO projects VALUES (2, '另一项目', '写实电影', '9:16'); INSERT INTO characters (id, project_id, name, age, face_features, gender_presentation) VALUES (1, 1, '林秋', 28, '圆脸，眉骨明显', '成年男性');");
  let bytes = png();
  let failed = false;
  let useUrl = false;
  let pause;
  let wait;
  let started;
  const requests = [];
  const provider = await listen(t, createServer(async (request, response) => {
    if (request.url === '/image.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body;
    if (request.headers['content-type'].startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      body = Object.fromEntries(form);
      body.image = Buffer.from(await form.get('image').arrayBuffer());
    } else body = JSON.parse(raw.toString());
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    if (wait) { started(); await wait; }
    response.writeHead(failed ? 500 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failed ? { error: { message: 'failure test-private-key' } } : { data: [useUrl ? { url: `${provider.url}/image.png` } : { b64_json: bytes.toString('base64') }] }));
  }));
  database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, ?, ?, ?, ?, ?)').run('文生图', 'text_to_image', provider.url + '/v1', 'test-private-key', 'actual-image-model');
  const app = await listen(t, createApp(database));
  const fields = () => ({ apiConfigId: '1', chargeConfirmed: 'yes', revision: characterRevision(database.prepare('SELECT * FROM characters WHERE id = 1').get(), '国风水墨'), model: 'actual-image-model', baseUrl: provider.url + '/v1' });
  const post = (fields, path = '/projects/1/characters/1/generate', options = {}) => fetch(app.url + path, { method: 'POST', body: new URLSearchParams(fields), ...options });
  return { database, ...app, requests, fields, post, setImage(value) { bytes = value; }, fail() { failed = true; }, useUrl() { useUrl = true; }, pause() { wait = new Promise(resolve => { pause = resolve; }); return new Promise(resolve => { started = resolve; }); }, resume() { pause(); wait = undefined; } };
}

test('预览下面提供生成按钮和已保存的文生图配置；按角色资料、项目画风、完整模板及精确 16:9 请求并保存本地图片', async t => {
  const f = await fixture(t);
  const detail = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(detail, /id="generate-character-image"[^>]*>生成图片/);
  assert.ok(detail.indexOf('id="generate-character-image"') > detail.indexOf('character-board-empty'));
  assert.match(detail, /文生图 · actual-image-model/);
  assert.doesNotMatch(detail, /test-private-key/);
  const response = await f.post(f.fields());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.path, '/v1/images/generations');
  assert.equal(request.authorization, 'Bearer test-private-key');
  assert.equal(request.body.model, 'actual-image-model');
  assert.equal(request.body.n, 1);
  assert.equal(request.body.size, '2560x1440');
  assert.match(request.body.prompt, /MANDATORY ART STYLE \/ 画风: 国风水墨/);
  assert.match(request.body.prompt, /圆脸，眉骨明显/);
  assert.match(request.body.prompt, /"年龄": 28/);
  assert.ok(request.body.prompt.endsWith(baseCharacterBoard.prompt));
  assert.doesNotMatch(request.body.prompt, /blue ceramic mug/);
  const image = await fetch(f.url + result.imageUrl);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(result.imageUrl));
  assert.match(html, /class="character-board-image"/);
  assert.match(await (await fetch(f.url + '/projects/1?resource=characters')).text(), /角色板已生成/);
  assert.equal((await fetch(f.url + result.imageUrl.replace('/projects/1/', '/projects/2/'))).status, 404);
  assert.equal((await fetch(f.url + result.imageUrl.replace(/boards\/\d+/, 'boards/999999'))).status, 404);
  const head = await fetch(f.url + result.imageUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(f.url + '/character-images.js')).status, 200);
});

test('未成年、未知年龄、错误类型、过期资料、越界及未确认扣费一律在发起付费调用前拒绝', async t => {
  const f = await fixture(t);
  for (const age of [null, 17]) {
    f.database.prepare('UPDATE characters SET age = ?').run(age);
    assert.equal((await f.post(f.fields())).status, 400);
    assert.match(await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text(), /id="generate-character-image"[^>]*disabled/);
  }
  f.database.exec('UPDATE characters SET age = 18');
  for (const [key, value, status] of [['chargeConfirmed', 'no', 400], ['revision', 'old', 409], ['model', 'changed', 409], ['baseUrl', 'changed', 409], ['apiConfigId', 'no', 400], ['apiConfigId', '999999', 404]]) assert.equal((await f.post({ ...f.fields(), [key]: value })).status, status);
  const duplicate = new URLSearchParams(f.fields()); duplicate.append('apiConfigId', '1');
  assert.equal((await f.post(duplicate)).status, 400);
  f.database.exec("UPDATE api_configs SET type = 'llm'");
  assert.equal((await f.post(f.fields())).status, 400);
  assert.match(await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text(), /尚无文生图配置/);
  for (const path of ['/projects/2/characters/1/generate', '/projects/1/characters/999999/generate', '/projects/1/characters/9007199254740992/generate']) assert.equal((await f.post(f.fields(), path)).status, 404);
  assert.equal((await f.post(f.fields(), undefined, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await f.post(f.fields(), undefined, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.post({ large: 'x'.repeat(33000) })).status, 413);
  assert.equal(f.requests.length, 0);
});

test('重新生成失败原图不变；非 16:9 结果保留可下载但不替换，不自动重试', async t => {
  const f = await fixture(t);
  const original = await (await f.post(f.fields())).json();
  f.setImage(png(10, 10));
  const mismatch = await (await f.post(f.fields())).json();
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.message, /不符合固定 16:9/);
  let html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${mismatch.imageUrl}"`));
  assert.ok(html.includes(`href="${mismatch.imageUrl}"`));
  assert.match(html, /未替换原角色板/);
  assert.equal(f.database.prepare('SELECT id FROM character_boards WHERE valid = 1').get().id, Number(original.imageUrl.split('/').at(-1)));
  assert.equal((await fetch(f.url + mismatch.imageUrl)).status, 200);
  f.fail();
  const response = await f.post(f.fields());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('test-private-key'));
  html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${mismatch.imageUrl}"`));
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 2);
  assert.equal(f.requests.length, 3);
});

test('服务端阻止同角色并发重复扣费；生成期间资料改变时保留结果但不替换角色板', async t => {
  const f = await fixture(t);
  const original = await (await f.post(f.fields())).json();
  const started = f.pause();
  const pending = f.post(f.fields());
  await started;
  const duplicate = await f.post(f.fields());
  assert.equal(duplicate.status, 409);
  f.database.exec("UPDATE characters SET face_features = '新五官'");
  f.resume();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, false);
  assert.match(result.message, /资料发生变化/);
  assert.equal(f.requests.length, 2);
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${result.imageUrl}"`));
  assert.equal(f.database.prepare('SELECT id FROM character_boards WHERE valid = 1').get().id, Number(original.imageUrl.split('/').at(-1)));
  assert.match(html, /现有图片对应旧资料/);
});

test('URL 结果下载到本地不携带密钥；拒绝未配置内网图片，不跟随下载重定向', async t => {
  const f = await fixture(t);
  f.useUrl();
  const response = await f.post(f.fields());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.imageUrl.startsWith('/projects/'));
  assert.deepEqual(Buffer.from(f.database.prepare('SELECT image FROM character_boards').get().image), png());
  await assert.rejects(() => loadImage('http://127.0.0.1:1/private', 'https://provider.test'), /未配置的内网/);
  const redirect = await listen(t, createServer((request, response) => { response.writeHead(302, { Location: '/elsewhere' }); response.end(); }));
  await assert.rejects(() => loadImage(redirect.url + '/image', redirect.url), /图片下载失败/);
});

test('AI修图使用当前预览图与所填要求，multipart 调用编辑配置；空要求和过期图片先拒绝，失败保留原图', async t => {
  const f = await fixture(t);
  const original = await (await f.post(f.fields())).json();
  f.database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (2, ?, ?, ?, ?, ?)').run('修图接口', 'image_edit', f.fields().baseUrl, 'edit-key', 'edit-model');
  const boardId = original.imageUrl.split('/').pop();
  const fields = { ...f.fields(), apiConfigId: '2', model: 'edit-model', boardId, instruction: '把头发改为黑色，其他保持不变' };
  const path = '/projects/1/characters/1/edit-image';
  assert.equal((await f.post({ ...fields, instruction: '' }, path)).status, 400);
  assert.equal((await f.post({ ...fields, instruction: 'x'.repeat(2001) }, path)).status, 400);
  assert.equal((await f.post({ ...fields, boardId: '99999' }, path)).status, 409);
  assert.equal((await f.post({ ...fields, apiConfigId: '1', model: 'actual-image-model' }, path)).status, 400);
  assert.equal((await f.post(fields, '/projects/2/characters/1/edit-image')).status, 404);
  assert.equal(f.requests.length, 1);
  const response = await f.post(fields, path);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.notEqual(result.imageUrl, original.imageUrl);
  const request = f.requests.at(-1);
  assert.equal(request.path, '/v1/images/edits');
  assert.equal(request.authorization, 'Bearer edit-key');
  assert.equal(request.body.model, 'edit-model');
  assert.equal(request.body.n, '1');
  assert.equal(request.body.size, '2560x1440');
  assert.match(request.body.prompt, /把头发改为黑色，其他保持不变/);
  assert.ok(request.body.prompt.replaceAll('\r\n', '\n').endsWith(baseCharacterBoard.prompt));
  assert.deepEqual(request.body.image, png());
  f.fail();
  const failure = await f.post({ ...fields, boardId: result.imageUrl.split('/').pop() }, path);
  assert.equal(failure.status, 502);
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${result.imageUrl}"`));
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 2);
});

test('清空图像不调用模型、不删除付费图片及角色资料，清空后列表和预览为空；新生图恢复显示，旧页面不能清新图片', async t => {
  const f = await fixture(t);
  const original = await (await f.post(f.fields())).json();
  const boardId = original.imageUrl.split('/').pop();
  const before = f.database.prepare('SELECT * FROM characters').get();
  const path = '/projects/1/characters/1/clear-image';
  assert.equal((await f.post({ boardId }, '/projects/2/characters/1/clear-image')).status, 404);
  assert.equal((await f.post({ boardId: '0' }, path)).status, 409);
  assert.equal((await f.post({ boardId }, path, { headers: { Origin: 'https://other.test' } })).status, 403);
  const response = await f.post({ boardId }, path);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cleared, true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM characters').get(), before);
  assert.equal(f.database.prepare('SELECT cleared FROM character_boards').get().cleared, 1);
  assert.equal((await fetch(f.url + original.imageUrl)).status, 200);
  let html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.doesNotMatch(html, /src="\/projects\//);
  assert.match(html, /id="edit-character-image"[^>]*disabled/);
  assert.match(await (await fetch(f.url + '/projects/1?resource=characters')).text(), /未生成角色板/);
  assert.equal((await f.post({ boardId }, path)).status, 400);
  const next = await (await f.post(f.fields())).json();
  assert.equal((await f.post({ boardId }, path)).status, 409);
  html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${next.imageUrl}"`));
});

test('修图或生图期间禁止清空，避免结果回写覆盖用户动作', async t => {
  const f = await fixture(t);
  const original = await (await f.post(f.fields())).json();
  const started = f.pause();
  const pending = f.post(f.fields());
  await started;
  const response = await f.post({ boardId: original.imageUrl.split('/').pop() }, '/projects/1/characters/1/clear-image');
  assert.equal(response.status, 409);
  f.resume();
  assert.equal((await pending).status, 200);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards WHERE cleared = 1').get().count, 0);
});

test('图片识别支持 PNG、JPEG、WebP 三种尺寸头，拒绝空图片及不安全尺寸', () => {
  assert.deepEqual(imageDetails(png()), { mime: 'image/png', width: 16, height: 9 });
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 9, 0, 16, 1, 1, 17, 0, 255, 217]);
  assert.deepEqual(imageDetails(jpeg), { mime: 'image/jpeg', width: 16, height: 9 });
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(15, 24, 3); webp.writeUIntLE(8, 27, 3);
  assert.deepEqual(imageDetails(webp), { mime: 'image/webp', width: 16, height: 9 });
  for (const bytes of [Buffer.from('not image'), jpeg.subarray(0, 5), webp.subarray(0, 12), Buffer.concat([png().subarray(0, 16), Buffer.from([255, 255, 255, 255]), png().subarray(20)])]) assert.throws(() => imageDetails(bytes), /图片/);
});

test('角色板在重启后保留；保存结果失败时可取回付费图片，旧图不受影响', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-board-persist-'));
  let reopened;
  try {
    const filename = join(directory, 'drama.sqlite');
    const f = await fixture(t, filename);
    const original = await (await f.post(f.fields())).json();
    f.database.exec("CREATE TRIGGER fail_board BEFORE INSERT ON character_boards BEGIN SELECT RAISE(ABORT, 'simulate disk write failure'); END;");
    const response = await f.post(f.fields());
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.match(result.error, /未能保存/);
    assert.equal(result.recoveryImage, `data:image/png;base64,${png().toString('base64')}`);
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 1);
    await f.close();
    reopened = openDatabase(filename);
    const server = await listen(t, createApp(reopened));
    const image = await fetch(server.url + original.imageUrl);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
    await server.close(); reopened = undefined;
  } finally { reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('版本 7 升级保留旧图片，默认不清空；升级失败回滚，清空标记重启后保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-clear-migrate-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = openDatabase(filename);
    database.exec("INSERT INTO projects VALUES (1, '原项目', '写实', '9:16'); INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '原角色', 28); ALTER TABLE character_boards DROP COLUMN cleared; PRAGMA user_version = 7;");
    database.prepare('INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (1, ?, ?, 16, 9, 1, ?, ?, ?)').run(png(), 'image/png', 'old-revision', 'old-model', 'old-prompt');
    const original = database.prepare('SELECT * FROM character_boards').get();
    database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 8')) throw new Error('clear migration failure'); return result; });
    assert.throws(() => openDatabase(filename), /clear migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
    assert.deepEqual(database.prepare('SELECT * FROM character_boards').get(), original);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual({ ...database.prepare('SELECT * FROM character_boards').get() }, { ...original, cleared: 0 });
    database.exec('UPDATE character_boards SET cleared = 1');
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('SELECT cleared FROM character_boards').get().cleared, 1);
    assert.equal(database.prepare('SELECT name FROM characters').get().name, '原角色');
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('版本 6 升级保留所有项目、角色和 API；迁移失败完整回滚，重复打开不丢图片', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-board-migrate-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = openDatabase(filename);
    database.exec("DROP TABLE character_boards; PRAGMA user_version = 6; INSERT INTO projects VALUES (1, '原项目', '水墨', '9:16'); INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '原角色', 28); INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('接口', 'text_to_image', 'https://example.test/v1', 'preserved-key', 'preserved-model');");
    const original = ['projects', 'characters', 'api_configs'].map(table => database.prepare(`SELECT * FROM ${table}`).all());
    database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 7')) throw new Error('migration failure'); return result; });
    assert.throws(() => openDatabase(filename), /migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'character_boards'").get(), undefined);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual(['projects', 'characters', 'api_configs'].map(table => database.prepare(`SELECT * FROM ${table}`).all()), original);
    assert.equal(database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 0);
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});
