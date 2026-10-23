import { png, sendImage, acknowledge, adoptResult, adoptResponse } from './helpers/weave-images.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { characterRevision } from '../src/character-images.js';
import { imageDetails } from '../src/images.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';


function referenceForm(bytes = png(), referenceId = '') {
  const form = new FormData();
  form.set('referenceId', referenceId);
  form.set('referenceImage', new Blob([bytes], { type: 'image/png' }), '身份.png');
  return form;
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
  t.after(() => { pause?.(); wait = undefined; });
  const requests = [], downloads = [];
  const provider = await listen(t, createServer(async (request, response) => {
    if (request.url === '/image.png') { downloads.push(request.url); response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (await acknowledge(database, request, response, raw)) return;
    let body;
    if (request.headers['content-type'].startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      body = Object.fromEntries(form);
      body.image = Buffer.from(await form.get('image').arrayBuffer());
    } else body = JSON.parse(raw.toString());
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    if (wait) { started(); await wait; }
    if (!failed && !useUrl) { sendImage(response, bytes); return; }
    response.writeHead(failed ? 500 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failed ? { error: { message: 'failure test-private-key' } } : { data: [useUrl ? { url: `${provider.url}/image.png` } : { b64_json: bytes.toString('base64') }] }));
  }));
  database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, ?, ?, ?, ?, ?)').run('文生图', 'text_to_image', provider.url + '/v1', 'test-private-key', 'ironweave');
  database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (2, ?, ?, ?, ?, ?)').run('身份参考生图', 'image_to_image', provider.url + '/v1', 'test-private-key', 'ironweave');
  const app = await listen(t, createApp(database));
  const fields = () => ({ apiConfigId: '1', chargeConfirmed: 'yes', size: '16x9', revision: characterRevision(database.prepare('SELECT * FROM characters WHERE id = 1').get(), '国风水墨'), model: 'ironweave', baseUrl: provider.url + '/v1' });
  const post = (fields, path = '/projects/1/characters/1/generate', options = {}) => fetch(app.url + path, { method: 'POST', body: new URLSearchParams(fields), ...options });
  return { database, ...app, requests, downloads, fields, post, async postAndAdopt(fields, path, options) { const response = await post(fields, path, options); return !path || path.endsWith('/generate') ? adoptResponse(app.url, response, 'character') : response; }, setImage(value) { bytes = value; }, fail() { failed = true; }, useUrl() { useUrl = true; }, pause() { wait = new Promise(resolve => { pause = resolve; }); return new Promise(resolve => { started = resolve; }); }, resume() { pause(); wait = undefined; } };
}

test('预览下面提供生成按钮和已保存的文生图配置；按角色资料、项目画风、完整模板及精确 16:9 请求并保存本地图片', async t => {
  const f = await fixture(t);
  const detail = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(detail, /id="generate-character-image"[^>]*>生成图片/);
  assert.ok(detail.indexOf('id="generate-character-image"') > detail.indexOf('character-board-empty'));
  assert.match(detail, /文生图 · ironweave/);
  assert.doesNotMatch(detail, /test-private-key/);
  const response = await f.postAndAdopt(f.fields());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.equal(f.database.prepare('SELECT length(image) AS n FROM character_boards').get().n, 0);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.path, '/v1/images/generations');
  assert.equal(request.authorization, 'Bearer test-private-key');
  assert.equal(request.body.model, 'ironweave');
  assert.equal(request.body.n, 1);
  assert.equal(request.body.size, '16x9');
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
    assert.equal((await f.postAndAdopt(f.fields())).status, 400);
    assert.match(await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text(), /id="generate-character-image"[^>]*disabled/);
  }
  f.database.exec('UPDATE characters SET age = 18');
  for (const [key, value, status] of [['chargeConfirmed', 'no', 400], ['revision', 'old', 409], ['model', 'changed', 409], ['baseUrl', 'changed', 409], ['apiConfigId', 'no', 400], ['apiConfigId', '999999', 404]]) assert.equal((await f.postAndAdopt({ ...f.fields(), [key]: value })).status, status);
  const duplicate = new URLSearchParams(f.fields()); duplicate.append('apiConfigId', '1');
  assert.equal((await f.postAndAdopt(duplicate)).status, 400);
  f.database.exec("UPDATE api_configs SET type = 'llm'");
  assert.equal((await f.postAndAdopt(f.fields())).status, 400);
  assert.match(await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text(), /尚无文生图配置/);
  for (const path of ['/projects/2/characters/1/generate', '/projects/1/characters/999999/generate', '/projects/1/characters/9007199254740992/generate']) assert.equal((await f.postAndAdopt(f.fields(), path)).status, 404);
  assert.equal((await f.postAndAdopt(f.fields(), undefined, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await f.postAndAdopt(f.fields(), undefined, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.postAndAdopt({ large: 'x'.repeat(33000) })).status, 413);
  assert.equal(f.requests.length, 0);
});

test('非本次尺寸不保存不ACK，原人工采用图不变，失败不自动重试', async t => {
  const f = await fixture(t), original = await (await f.postAndAdopt(f.fields())).json();
  f.setImage(png(10, 10));
  const response = await f.post(f.fields()); assert.equal(response.status, 502);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_boards').get().n, 1);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM generation_operations WHERE local_state='confirmed'").get().n, 1);
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${original.imageUrl}"`)); assert.equal(f.requests.length, 2);
  assert.equal((await f.post(f.fields())).status, 409); assert.equal(f.requests.length, 2);
});

test('服务端阻止同角色并发重复扣费；生成期间资料改变时保留结果但不替换角色板', async t => {
  const f = await fixture(t);
  const original = await (await f.postAndAdopt(f.fields())).json();
  const started = f.pause();
  const pending = f.post(f.fields());
  await started;
  const duplicate = await f.postAndAdopt(f.fields());
  assert.equal(duplicate.status, 409);
  f.database.exec("UPDATE characters SET face_features = '新五官'");
  f.resume();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, false);
  await assert.rejects(adoptResult(f.url, result, 'character'), { status: 409 });
  assert.equal(result.operation.deliveryConfirmed, true);
  assert.equal(f.requests.length, 2);
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${original.imageUrl}"`));
  assert.equal(f.database.prepare('SELECT id FROM character_boards WHERE valid = 1').get().id, Number(original.imageUrl.split('/').at(-1)));
  assert.match(html, /现有图片对应旧资料/);
});

test('旧URL单JSON结果明确拒绝，不下载、不产生BLOB、不自动重试或泄露密钥', async t => {
  const f = await fixture(t); f.useUrl();
  const response = await f.post(f.fields()); assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /test-private-key/);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_boards').get().n, 0);
  assert.equal((await f.post(f.fields())).status, 409); assert.equal(f.requests.length, 1); assert.deepEqual(f.downloads, []);
});

test('Weave不提供遮罩按钮或对话框，旧入口明确503，不付费、不整图回退、不改变角色板', async t => {
  const f = await fixture(t);
  const original = await (await f.postAndAdopt(f.fields())).json();
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.doesNotMatch(html, /id="edit-character-image"|image-edit-dialog|submit-character-edit/);
  assert.match(html, /Weave 不支持遮罩修图/);
  const path = '/projects/1/characters/1/edit-image';
  const response = await f.postAndAdopt({ ...f.fields(), boardId: original.imageUrl.split('/').pop(), instruction: '修复手指', mask: 'selected-mask' }, path);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /不会调用模型或回退为整图编辑/);
  assert.equal((await f.postAndAdopt({}, '/projects/2/characters/1/edit-image')).status, 404);
  assert.equal(f.requests.length, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 1);
  for (const file of ['/image-editor.js', '/image-mask.js']) assert.equal((await fetch(f.url + file)).status, 200);
});

test('清空图像不调用模型、不删除付费图片及角色资料，清空后列表和预览为空；新生图恢复显示，旧页面不能清新图片', async t => {
  const f = await fixture(t);
  const original = await (await f.postAndAdopt(f.fields())).json();
  const boardId = original.imageUrl.split('/').pop();
  const before = f.database.prepare('SELECT * FROM characters').get();
  const path = '/projects/1/characters/1/clear-image';
  assert.equal((await f.postAndAdopt({ boardId }, '/projects/2/characters/1/clear-image')).status, 404);
  assert.equal((await f.postAndAdopt({ boardId: '0' }, path)).status, 409);
  assert.equal((await f.postAndAdopt({ boardId }, path, { headers: { Origin: 'https://other.test' } })).status, 403);
  const response = await f.postAndAdopt({ boardId }, path);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cleared, true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM characters').get(), before);
  assert.equal(f.database.prepare('SELECT cleared FROM character_boards').get().cleared, 1);
  assert.equal((await fetch(f.url + original.imageUrl)).status, 200);
  let html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.doesNotMatch(html, /src="\/projects\//);
  assert.doesNotMatch(html, /id="edit-character-image"/);
  assert.match(await (await fetch(f.url + '/projects/1?resource=characters')).text(), /未生成角色板/);
  assert.equal((await f.postAndAdopt({ boardId }, path)).status, 400);
  const next = await (await f.postAndAdopt(f.fields())).json();
  assert.equal((await f.postAndAdopt({ boardId }, path)).status, 409);
  html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.ok(html.includes(`src="${next.imageUrl}"`));
});

test('生图期间禁止清空，避免结果回写覆盖用户动作', async t => {
  const f = await fixture(t);
  const original = await (await f.postAndAdopt(f.fields())).json();
  const started = f.pause();
  const pending = f.postAndAdopt(f.fields());
  await started;
  const response = await f.postAndAdopt({ boardId: original.imageUrl.split('/').pop() }, '/projects/1/characters/1/clear-image');
  assert.equal(response.status, 409);
  f.resume();
  assert.equal((await pending).status, 200);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards WHERE cleared = 1').get().count, 0);
});

test('付费生成进行中不能删除角色或所属短剧，完成后才能删除，避免丢失付费结果', async t => {
  const f = await fixture(t);
  const started = f.pause();
  const pending = f.postAndAdopt(f.fields());
  await started;
  for (const [path, name] of [['/projects/1/characters/1/delete', '林秋'], ['/projects/1/delete', '原项目']]) {
    const response = await f.postAndAdopt({ confirmed: 'yes', name }, path);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /等待完成后再操作|请先停止当前传输/);
  }
  f.resume();
  assert.equal((await pending).status, 200);
  assert.equal((await f.postAndAdopt({ confirmed: 'yes', name: '林秋' }, '/projects/1/characters/1/delete')).status, 200);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 0);
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
    const original = await (await f.postAndAdopt(f.fields())).json();
    f.database.exec("CREATE TRIGGER fail_board BEFORE INSERT ON character_boards BEGIN SELECT RAISE(ABORT, 'simulate disk write failure'); END;");
    const generated = await (await f.post(f.fields())).json();
    assert.equal(generated.operation.deliveryConfirmed, true);
    await assert.rejects(adoptResult(f.url, generated, 'character'), { status: 500 });
    assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 1);
    assert.deepEqual(Buffer.from(await (await fetch(f.url + generated.imageUrl)).arrayBuffer()), png());
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM generated_media_links').get().n, 1);
    await f.close();
    reopened = openDatabase(filename);
    const server = await listen(t, createApp(reopened));
    const image = await fetch(server.url + original.imageUrl);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
    await server.close(); reopened = undefined;
  } finally { reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('上传参考图只保存本地图片，自动改为图生图 API；原始字节、HEAD、项目归属与输入校验完整', async t => {
  const f = await fixture(t);
  const path = '/projects/1/characters/1/reference-image';
  const upload = body => fetch(f.url + path, { method: 'POST', body });
  assert.equal((await upload(referenceForm(Buffer.from('not an image')))).status, 400);
  assert.equal((await upload(referenceForm(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 413);
  const duplicate = referenceForm(); duplicate.append('referenceImage', new Blob([png()]));
  assert.equal((await upload(duplicate)).status, 400);
  assert.equal((await fetch(f.url + path, { method: 'POST', body: referenceForm(), headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(f.url + path.replace('/projects/1/', '/projects/2/'), { method: 'POST', body: referenceForm() })).status, 404);
  const response = await upload(referenceForm()); assert.equal(response.status, 201);
  const { referenceId } = await response.json();
  const imageUrl = `/projects/1/characters/1/references/${referenceId}`;
  const image = await fetch(f.url + imageUrl);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
  assert.equal((await fetch(f.url + imageUrl, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(f.url + imageUrl.replace('/projects/1/', '/projects/2/'))).status, 404);
  const html = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(html, /图生图 API/); assert.match(html, /身份参考生图 · ironweave/);
  assert.doesNotMatch(html, /文生图 · ironweave|test-private-key/);
  assert.ok(html.includes(`data-reference-id="${referenceId}"`));
  assert.equal(f.requests.length, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_boards').get().n, 0);
  assert.equal((await upload(referenceForm())).status, 409);
  assert.deepEqual(Buffer.from(f.database.prepare('SELECT image FROM character_references').get().image), png());
  f.database.exec('DELETE FROM api_configs WHERE id = 2');
  const withoutConfig = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(withoutConfig, /尚无图生图配置/);
  assert.match(withoutConfig, /id="generate-character-image"[^>]*disabled/);
  assert.equal((await f.postAndAdopt({ ...f.fields(), referenceId: String(referenceId) })).status, 400);
  assert.equal(f.requests.length, 0);
});

test('参考生图上传真实图片字节和专用身份提示词，保留画风、成人与四视图规则；来源 ID 随结果保存，失败不重试', async t => {
  const f = await fixture(t);
  const { referenceId } = await (await fetch(f.url + '/projects/1/characters/1/reference-image', { method: 'POST', body: referenceForm() })).json();
  const fields = { ...f.fields(), referenceId: String(referenceId), apiConfigId: '2', model: 'ironweave' };
  const response = await f.postAndAdopt(fields); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.valid, true);
  const request = f.requests[0];
  assert.equal(request.path, '/v1/images/edits'); assert.equal(request.body.model, 'ironweave');
  assert.equal(request.body.size, '16x9'); assert.equal(request.body.n, '1');
  assert.deepEqual(request.body.image, png());
  assert.ok(request.body.prompt.replaceAll('\r\n', '\n').endsWith(referenceCharacterBoard.prompt));
  assert.match(request.body.prompt, /MANDATORY ART STYLE \/ 画风: 国风水墨/);
  assert.match(request.body.prompt, /primary anchor/);
  assert.match(request.body.prompt, /Do not copy the reference's clothing/);
  assert.match(request.body.prompt, /aged 18 or older/);
  const saved = f.database.prepare('SELECT reference_id, prompt FROM character_boards').get();
  assert.equal(saved.reference_id, referenceId);
  assert.equal(saved.prompt, request.body.prompt.replaceAll('\r\n', '\n'));
  f.fail(); assert.equal((await f.postAndAdopt(fields)).status, 502);
  assert.equal(f.requests.length, 2);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_boards').get().n, 1);
  assert.ok((await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text()).includes(result.imageUrl));
});

test('参考图快照、API 类型和成人年龄在计费前验证；替换或移除不动角色板，旧参考图保留，移除后恢复文生图', async t => {
  const f = await fixture(t), path = '/projects/1/characters/1/reference-image';
  const { referenceId } = await (await fetch(f.url + path, { method: 'POST', body: referenceForm() })).json();
  const fields = { ...f.fields(), apiConfigId: '2', model: 'ironweave', referenceId: String(referenceId) };
  assert.equal((await f.postAndAdopt(f.fields())).status, 409);
  assert.equal((await f.postAndAdopt({ ...f.fields(), referenceId: String(referenceId) })).status, 400);
  f.database.exec('UPDATE characters SET age = 17');
  assert.equal((await f.postAndAdopt({ ...fields, revision: f.fields().revision })).status, 400);
  f.database.exec('UPDATE characters SET age = 28');
  const { referenceId: next } = await (await fetch(f.url + path, { method: 'POST', body: referenceForm(png(10, 10), String(referenceId)) })).json();
  assert.equal((await f.postAndAdopt(fields)).status, 409);
  assert.equal((await f.postAndAdopt({ referenceId: String(referenceId) }, '/projects/1/characters/1/clear-reference')).status, 409);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.postAndAdopt({ ...fields, referenceId: String(next) })).status, 200);
  assert.equal((await f.postAndAdopt({ referenceId: String(next) }, '/projects/1/characters/1/clear-reference')).status, 200);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_references WHERE cleared = 1').get().n, 2);
  assert.equal(f.database.prepare('SELECT reference_id FROM character_boards').get().reference_id, next);
  assert.equal((await fetch(f.url + `/projects/1/characters/1/references/${referenceId}`)).status, 200);
  assert.equal((await f.postAndAdopt(f.fields())).status, 200);
  assert.equal(f.requests.at(-1).path, '/v1/images/generations');
  assert.equal(f.database.prepare('SELECT reference_id FROM character_boards ORDER BY id DESC').get().reference_id, null);
});

test('参考生图期间不能替换或移除；异常并发改变参考图时保留未通过结果和实际来源，不覆盖旧板', async t => {
  const f = await fixture(t), path = '/projects/1/characters/1/reference-image';
  const { referenceId } = await (await fetch(f.url + path, { method: 'POST', body: referenceForm() })).json();
  const started = f.pause();
  const pending = f.post({ ...f.fields(), apiConfigId: '2', model: 'ironweave', referenceId: String(referenceId) });
  await started;
  assert.equal((await fetch(f.url + path, { method: 'POST', body: referenceForm(png(), String(referenceId)) })).status, 409);
  assert.equal((await f.postAndAdopt({ referenceId: String(referenceId) }, '/projects/1/characters/1/clear-reference')).status, 409);
  f.database.exec('UPDATE character_references SET cleared = 1');
  f.resume();
  const result = await (await pending).json();
  assert.equal(result.valid, false); await assert.rejects(adoptResult(f.url, result, 'character'), { status: 409 });
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM character_boards').get().n, 0);
  assert.equal(JSON.parse(f.database.prepare('SELECT source_json FROM generation_operations').get().source_json).referenceId, referenceId);
});

test('参考图与来源关联重启后保留，删除 API 不影响图片，删除角色或短剧级联清理历史参考图', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-reference-persist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, join(directory, 'drama.sqlite'));
  const { referenceId } = await (await fetch(f.url + '/projects/1/characters/1/reference-image', { method: 'POST', body: referenceForm() })).json();
  await f.postAndAdopt({ ...f.fields(), apiConfigId: '2', model: 'ironweave', referenceId: String(referenceId) });
  await f.close();
  const database = openDatabase(join(directory, 'drama.sqlite'));
  const app = await listen(t, createApp(database));
  assert.deepEqual(Buffer.from(database.prepare('SELECT image FROM character_references').get().image), png());
  assert.equal(database.prepare('SELECT reference_id FROM character_boards').get().reference_id, referenceId);
  const postDelete = (path, name) => fetch(app.url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }) });
  assert.equal((await postDelete('/settings/api/2/delete', '身份参考生图')).status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM character_references').get().n, 1);
  assert.equal((await postDelete('/projects/1/characters/1/delete', '林秋')).status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM character_references').get().n, 0);
  database.exec("INSERT INTO characters (project_id, name) VALUES (1, '新角色')");
  const id = database.prepare('SELECT id FROM characters').get().id;
  const next = Number(database.prepare("INSERT INTO character_references (character_id, image, mime, width, height) VALUES (?, ?, 'image/png', 16, 9)").run(id, png()).lastInsertRowid);
  assert.ok(next > referenceId);
  assert.equal((await postDelete('/projects/1/delete', '原项目')).status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM character_references').get().n, 0);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('版本 7 升级保留旧图片，默认不清空；升级失败回滚，清空标记重启后保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-clear-migrate-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = openDatabase(filename);
    database.exec('DROP TABLE look_images; DROP TABLE look_assets; DROP TABLE looks; DROP TABLE production_asset_images; DROP TABLE production_assets; DROP TABLE episode_storyboards; DROP TABLE scene_images; DROP TABLE scene_references; DROP TABLE episode_occurrences; DROP TABLE episode_extractions; DROP TABLE scenes; DROP TABLE episode_scripts; ALTER TABLE character_boards DROP COLUMN reference_id; DROP TABLE character_references;');
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
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 18);
    assert.deepEqual({ ...database.prepare('SELECT * FROM character_boards').get() }, { ...original, cleared: 0, reference_id: null });
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
    database.exec("DROP TABLE look_images; DROP TABLE look_assets; DROP TABLE looks; DROP TABLE production_asset_images; DROP TABLE production_assets; DROP TABLE episode_storyboards; DROP TABLE scene_images; DROP TABLE scene_references; DROP TABLE episode_occurrences; DROP TABLE episode_extractions; DROP TABLE scenes; DROP TABLE episode_scripts; DROP TABLE character_boards; DROP TABLE character_references; PRAGMA user_version = 6; INSERT INTO projects VALUES (1, '原项目', '水墨', '9:16'); INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '原角色', 28); INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('接口', 'text_to_image', 'https://example.test/v1', 'preserved-key', 'preserved-model');");
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
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 18);
    assert.deepEqual(['projects', 'characters', 'api_configs'].map(table => database.prepare(`SELECT * FROM ${table}`).all()), original);
    assert.equal(database.prepare('SELECT count(*) AS count FROM character_boards').get().count, 0);
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});
