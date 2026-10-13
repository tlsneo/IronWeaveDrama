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
import { sceneRevision, sceneImageUrl, generateSceneImage, readSceneReference, saveSceneReference, clearSceneReference, clearSceneImage } from '../src/scene-images.js';
import { sceneImagePrompt } from '../prompts/scene/reference-image.js';

const base = '/projects/1/scenes/1';
const detail = '/projects/1?resource=scenes&scene=1';
const cards = '/projects/1?resource=scenes';

function png(width = 16, height = 9) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(body.length + 8);
    output.writeUInt32BE(data.length); body.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function referenceForm(bytes = png(), referenceId = '') {
  const form = new FormData();
  form.set('referenceId', referenceId);
  form.set('referenceImage', new Blob([bytes], { type: 'image/png' }), '场景.png');
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
  database.exec("INSERT INTO projects VALUES (1, '原项目', '国风水墨', '16:9'), (2, '另一项目', '写实电影', '9:16'); INSERT INTO scenes (id, project_id, name, description) VALUES (1, 1, '旧车站', '砖墙，木长椅，入口在左侧'), (2, 1, '小院', ''), (3, 2, '异地', ''); INSERT INTO characters (project_id, name, age) VALUES (1, '未成年角色', 12), (1, '未知年龄角色', NULL);");
  let bytes = png(), mode = 'base64', result;
  let wait, release, started;
  const requests = [], downloads = [];
  const resume = () => { release?.(); wait = undefined; release = undefined; };
  t.after(resume);
  const provider = await listen(t, createServer(async (request, response) => {
    if (request.url === '/image.png') {
      downloads.push({ authorization: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const contentType = request.headers['content-type'];
    let body;
    if (contentType.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData();
      body = Object.fromEntries(form);
      body.image = Buffer.from(await form.get('image').arrayBuffer());
    } else body = JSON.parse(raw.toString());
    requests.push({ path: request.url, authorization: request.headers.authorization, contentType, body });
    if (wait) { started(); await wait; }
    response.writeHead(mode === 'failure' ? 500 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(mode === 'failure' ? { error: { message: 'failure test-private-key' } }
      : mode === 'result' ? result : { data: [mode === 'url' ? { url: `${provider.url}/image.png` } : { b64_json: bytes.toString('base64') }] }));
  }));
  database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, ?, ?, ?, ?, ?)').run('文生图', 'text_to_image', provider.url + '/v1', 'test-private-key', 'actual-image-model');
  database.prepare('INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (2, ?, ?, ?, ?, ?)').run('环境参考生图', 'image_to_image', provider.url + '/v1', 'test-private-key', 'actual-reference-model');
  const app = await listen(t, createApp(database));
  const fields = (id = 1, configId = '1') => {
    const scene = database.prepare('SELECT * FROM scenes WHERE id = ?').get(id);
    const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
    const config = database.prepare('SELECT * FROM api_configs WHERE id = ?').get(configId);
    return { apiConfigId: configId, chargeConfirmed: 'yes', revision: sceneRevision(scene, project), model: config.model, baseUrl: config.base_url, referenceId: String(readSceneReference(database, id)?.id ?? '') };
  };
  const post = (values, path = base + '/generate', options = {}) => fetch(app.url + path, { method: 'POST', body: new URLSearchParams(values), ...options });
  return { database, ...app, requests, downloads, fields, post,
    generate(values = fields(), id = 1, projectId = 1) { return generateSceneImage(database, projectId, id, new URLSearchParams(values)); },
    setImage(value) { bytes = value; }, mode(value, payload) { mode = value; result = payload; },
    pause() { wait = new Promise(resolve => { release = resolve; }); return new Promise(resolve => { started = resolve; }); }, resume };
}

const rows = database => database.prepare('SELECT * FROM scene_images ORDER BY id').all();
const imageId = result => result.imageUrl.split('/').at(-1);
const normalizedPrompt = request => request.body.prompt.replaceAll('\r\n', '\n');

test('所有项目比例映射到规定尺寸；仅显式生成单张空场景，保存画风、版本和环境提示词，不检查角色年龄', async t => {
  const f = await fixture(t);
  const mappings = { '16:9': '2560x1440', '9:16': '1440x2560', '21:9': '2688x1152', '4:3': '2048x1536', '3:4': '1536x2048', '1:1': '2048x2048' };
  for (const [ratio, size] of Object.entries(mappings)) {
    f.database.prepare('UPDATE projects SET aspect_ratio = ? WHERE id = 1').run(ratio);
    const [width, height] = ratio.split(':').map(Number);
    f.setImage(png(width, height));
    const fields = f.fields(), result = await f.generate(fields), request = f.requests.at(-1), saved = rows(f.database).at(-1);
    assert.equal(result.valid, true); assert.equal(request.path, '/v1/images/generations');
    assert.equal(request.body.size, size); assert.equal(request.body.n, 1);
    assert.equal(request.authorization, 'Bearer test-private-key'); assert.equal(request.body.model, fields.model);
    assert.match(request.body.prompt, /MANDATORY ART STYLE: 国风水墨/);
    assert.ok(request.body.prompt.includes(`OUTPUT ASPECT RATIO: ${ratio}`));
    assert.match(request.body.prompt, /旧车站/); assert.match(request.body.prompt, /砖墙，木长椅，入口在左侧/);
    assert.ok(request.body.prompt.endsWith(sceneImagePrompt));
    assert.match(request.body.prompt, /exactly ONE production reference image/);
    assert.match(request.body.prompt, /unoccupied environment/); assert.match(request.body.prompt, /Do not add people, animals/);
    assert.doesNotMatch(request.body.prompt, /ADULT CHARACTER IDENTITY|成年角色基础外观|aged 18 or older|four views|blue ceramic mug/);
    assert.equal(saved.revision, fields.revision); assert.equal(saved.prompt, request.body.prompt);
    assert.equal(saved.model, fields.model); assert.equal(saved.reference_id, null);
    assert.equal(saved.mime, 'image/png'); assert.equal(saved.width, width); assert.equal(saved.height, height);
    assert.deepEqual(Buffer.from(saved.image), png(width, height));
    assert.equal(result.imageUrl, sceneImageUrl(1, 1, saved.id));
  }
  assert.equal(f.requests.length, 6);
  const scene = f.database.prepare('SELECT * FROM scenes WHERE id = 1').get();
  const project = f.database.prepare('SELECT * FROM projects WHERE id = 1').get();
  assert.equal(sceneRevision(scene, project), sceneRevision({ ...scene, id: 999 }, { ...project, name: '改项目名称' }));
  for (const change of [{ name: '新地点' }, { description: '新布局' }]) assert.notEqual(sceneRevision(scene, project), sceneRevision({ ...scene, ...change }, project));
  for (const change of [{ style: '写实' }, { aspect_ratio: '9:16' }]) assert.notEqual(sceneRevision(scene, project), sceneRevision(scene, { ...project, ...change }));
});

test('HTTP 保存和上传不会付费；参考图输入校验、大小限制、归属、MIME、尺寸、GET/HEAD 和旧页面快照', async t => {
  const f = await fixture(t), path = base + '/reference-image';
  assert.equal((await f.post({ name: '空车站', description: '' }, base)).status, 200);
  for (const url of [detail, cards]) assert.equal((await fetch(f.url + url)).status, 200);
  const upload = (body, url = path, options = {}) => fetch(f.url + url, { method: 'POST', body, ...options });
  assert.equal((await upload(referenceForm(Buffer.from('not image')))).status, 400);
  assert.equal((await upload(referenceForm(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 413);
  const duplicate = referenceForm(); duplicate.append('referenceImage', new Blob([png()]));
  assert.equal((await upload(duplicate)).status, 400);
  assert.equal((await upload(referenceForm(), path, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await upload(referenceForm(), path.replace('/projects/1/', '/projects/2/'))).status, 404);
  const response = await upload(referenceForm(png(10, 10))); assert.equal(response.status, 201);
  const { referenceId } = await response.json(), imageUrl = `${base}/references/${referenceId}`;
  assert.deepEqual({ ...readSceneReference(f.database, 1) }, { id: referenceId, mime: 'image/png', width: 10, height: 10 });
  const image = await fetch(f.url + imageUrl); assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png(10, 10));
  const head = await fetch(f.url + imageUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const url of [imageUrl.replace('/projects/1/', '/projects/2/'), imageUrl.replace('/scenes/1/', '/scenes/2/'), `${base}/references/999999`]) assert.equal((await fetch(f.url + url)).status, 404);
  assert.equal((await upload(referenceForm())).status, 409);
  assert.equal(f.requests.length, 0); assert.equal(rows(f.database).length, 0);
  assert.equal(f.database.prepare('SELECT description FROM scenes WHERE id = 1').get().description, '');
});

test('HTTP 显式生成、本地图片和 URL 图片下载：校验真实字节、归属、响应 MIME、HEAD，不向下载请求泄漏密钥', async t => {
  const f = await fixture(t);
  const response = await f.post(f.fields()); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.valid, true); assert.equal(result.width, 16); assert.equal(result.height, 9);
  assert.equal(f.requests.length, 1);
  const image = await fetch(f.url + result.imageUrl); assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-length'), String(png().length));
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
  const head = await fetch(f.url + result.imageUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const url of [result.imageUrl.replace('/projects/1/', '/projects/2/'), result.imageUrl.replace('/scenes/1/', '/scenes/2/'), `${base}/images/999999`, `${base}/images/9007199254740992`]) assert.equal((await fetch(f.url + url)).status, 404);
  f.mode('url'); assert.equal((await f.post(f.fields())).status, 200);
  assert.deepEqual(f.downloads, [{ authorization: undefined }]);
  assert.equal(f.requests.length, 2); assert.deepEqual(Buffer.from(rows(f.database).at(-1).image), png());
});

test('计费前拒绝重复或缺失参数、未确认、过期版本/画风/比例/API/参考快照以及错误 API 类型，不回退', async t => {
  const f = await fixture(t), original = f.fields();
  for (const [key, value, status] of [['chargeConfirmed', 'no', 400], ['revision', 'old', 409], ['model', 'changed', 409], ['baseUrl', 'changed', 409], ['apiConfigId', 'no', 400], ['apiConfigId', '999999', 404], ['referenceId', '999999', 409]]) await assert.rejects(f.generate({ ...original, [key]: value }), { status });
  for (const key of ['apiConfigId', 'chargeConfirmed', 'revision', 'model', 'baseUrl']) {
    const missing = { ...original }; delete missing[key]; await assert.rejects(f.generate(missing), { status: 400 });
    const duplicate = new URLSearchParams(original); duplicate.append(key, original[key]); await assert.rejects(f.generate(duplicate), { status: 400 });
  }
  for (const [sql, restore] of [
    ["UPDATE scenes SET name = '新车站' WHERE id = 1", "UPDATE scenes SET name = '旧车站' WHERE id = 1"],
    ["UPDATE scenes SET description = '新布局' WHERE id = 1", "UPDATE scenes SET description = '砖墙，木长椅，入口在左侧' WHERE id = 1"],
    ["UPDATE projects SET style = '写实' WHERE id = 1", "UPDATE projects SET style = '国风水墨' WHERE id = 1"],
    ["UPDATE projects SET aspect_ratio = '9:16' WHERE id = 1", "UPDATE projects SET aspect_ratio = '16:9' WHERE id = 1"],
  ]) { f.database.exec(sql); await assert.rejects(f.generate(original), { status: 409 }); f.database.exec(restore); }
  for (const type of ['llm', 'image_to_image', 'image_edit']) {
    f.database.prepare('UPDATE api_configs SET type = ? WHERE id = 1').run(type);
    await assert.rejects(f.generate(f.fields()), { status: 400 });
  }
  f.database.exec("UPDATE api_configs SET type = 'text_to_image', api_key = '' WHERE id = 1");
  await assert.rejects(f.generate(f.fields()), { status: 400 });
  f.database.exec("UPDATE api_configs SET api_key = 'test-private-key' WHERE id = 1");
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  await assert.rejects(f.generate(original), { status: 409 });
  await assert.rejects(f.generate(f.fields()), { status: 400 });
  const duplicateRef = new URLSearchParams(f.fields(1, '2')); duplicateRef.append('referenceId', String(referenceId));
  await assert.rejects(f.generate(duplicateRef), { status: 400 });
  await assert.rejects(f.generate(original, 1, 2), { status: 404 });
  await assert.rejects(f.generate(original, 999999), { status: 404 });
  for (const [values, path, options, status] of [
    [f.fields(1, '2'), undefined, { headers: { Origin: 'https://other.test' } }, 403],
    [f.fields(1, '2'), undefined, { headers: { 'Content-Type': 'application/json' } }, 415],
    [{ large: 'x'.repeat(33000) }, undefined, {}, 413],
    [original, '/projects/2/scenes/1/generate', {}, 404],
    [original, '/projects/1/scenes/9007199254740992/generate', {}, 404],
  ]) assert.equal((await f.post(values, path, options)).status, status);
  assert.equal(f.requests.length, 0); assert.equal(rows(f.database).length, 0);
});

test('参考生图只用 multipart edits、真实参考字节与空场景提示词；严格图生图类型，无配置或失败不改走文生图', async t => {
  const f = await fixture(t);
  const source = png(10, 10);
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm(source));
  const fields = f.fields(1, '2');
  const result = await f.generate(fields); assert.equal(result.valid, true);
  const request = f.requests[0];
  assert.equal(request.path, '/v1/images/edits'); assert.match(request.contentType, /^multipart\/form-data; boundary=/);
  assert.equal(request.body.model, 'actual-reference-model'); assert.equal(request.body.size, '2560x1440'); assert.equal(request.body.n, '1');
  assert.deepEqual(request.body.image, source);
  assert.ok(normalizedPrompt(request).endsWith(sceneImagePrompt));
  assert.match(request.body.prompt, /primary location reference/); assert.match(request.body.prompt, /recognizable architecture, layout, scale/);
  assert.doesNotMatch(request.body.prompt, /ADULT CHARACTER IDENTITY|成年角色基础外观|aged 18 or older/);
  const saved = rows(f.database)[0]; assert.equal(saved.reference_id, referenceId); assert.equal(saved.prompt, normalizedPrompt(request));
  f.database.exec("UPDATE api_configs SET type = 'text_to_image' WHERE id = 2");
  await assert.rejects(f.generate(fields), { status: 400 }); assert.equal(f.requests.length, 1);
  f.database.exec("UPDATE api_configs SET type = 'image_to_image' WHERE id = 2");
  f.mode('failure'); await assert.rejects(f.generate(fields), error => error.status === 502 && !error.message.includes('test-private-key'));
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(request => request.path === '/v1/images/edits'));
  assert.equal(rows(f.database).length, 1);
  f.database.exec('DELETE FROM api_configs WHERE id = 2');
  await assert.rejects(f.generate(fields), { status: 404 }); assert.equal(f.requests.length, 2);
  const html = await (await fetch(f.url + detail)).text();
  assert.match(html, /尚无图生图配置/); assert.doesNotMatch(html, /文生图 · actual-image-model|test-private-key/);
});

test('同场景生成锁阻止重复扣费、清图、参考替换/移除、保存和场景/项目删除，完成后释放', async t => {
  const f = await fixture(t);
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  const original = await f.generate(f.fields(1, '2'));
  const scene = f.database.prepare('SELECT * FROM scenes WHERE id = 1').get();
  const started = f.pause(), pending = f.generate(f.fields(1, '2'));
  await started;
  try {
    await assert.rejects(f.generate(f.fields(1, '2')), { status: 409 });
    const responses = await Promise.all([
      f.post(f.fields(1, '2')),
      f.post({ boardId: imageId(original) }, base + '/clear-image'),
      fetch(f.url + base + '/reference-image', { method: 'POST', body: referenceForm(png(), String(referenceId)) }),
      f.post({ referenceId: String(referenceId) }, base + '/clear-reference'),
      f.post({ name: '被阻止的修改', description: '新描述' }, base),
      f.post({ confirmed: 'yes', name: '旧车站' }, base + '/delete'),
      f.post({ confirmed: 'yes', name: '原项目' }, '/projects/1/delete'),
    ]);
    assert.deepEqual(responses.map(response => response.status), Array(7).fill(409));
    assert.deepEqual(f.database.prepare('SELECT * FROM scenes WHERE id = 1').get(), scene);
    assert.equal(f.requests.length, 2);
  } finally { f.resume(); await pending; }
  assert.equal((await f.generate(f.fields(1, '2'))).valid, true);
  assert.equal((await f.post({ name: scene.name, description: scene.description }, base)).status, 200);
});

test('生成中的资料、画风、比例或参考图快照变化：保留实际来源及旧有效图，新结果不替换且不重试', async t => {
  const f = await fixture(t), original = await f.generate();
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  const changes = [
    "UPDATE scenes SET description = '布局改变' WHERE id = 1",
    "UPDATE projects SET style = '写实' WHERE id = 1",
    "UPDATE projects SET aspect_ratio = '9:16' WHERE id = 1",
    'UPDATE scene_references SET cleared = 1 WHERE scene_id = 1',
  ];
  for (const sql of changes) {
    f.database.exec("UPDATE scenes SET description = '砖墙，木长椅，入口在左侧' WHERE id = 1; UPDATE projects SET style = '国风水墨', aspect_ratio = '16:9' WHERE id = 1; UPDATE scene_references SET cleared = 0 WHERE scene_id = 1;");
    const fields = f.fields(1, '2'), started = f.pause(), pending = f.generate(fields);
    await started;
    let result;
    try { f.database.exec(sql); } finally { f.resume(); result = await pending; }
    assert.equal(result.valid, false); assert.match(result.message, /资料或参考图发生变化/);
    const saved = rows(f.database).at(-1);
    assert.equal(saved.reference_id, referenceId); assert.equal(saved.revision, fields.revision);
    assert.match(saved.prompt, /OUTPUT ASPECT RATIO: 16:9/); assert.match(saved.prompt, /MANDATORY ART STYLE: 国风水墨/);
    assert.equal(f.database.prepare('SELECT id FROM scene_images WHERE valid = 1').get().id, Number(imageId(original)));
  }
  assert.equal(f.requests.length, 5); assert.equal(rows(f.database).length, 5);
});

test('错误比例可保留下载而不替换；坏图片/响应、服务商失败和保存失败均不重试，保存失败提供原字节恢复', async t => {
  const f = await fixture(t), original = await f.generate(), saved = rows(f.database)[0];
  f.setImage(png(10, 10));
  const mismatch = await f.generate(); assert.equal(mismatch.valid, false); assert.match(mismatch.message, /不符合项目 16:9/);
  assert.equal(rows(f.database).at(-1).valid, 0); assert.deepEqual(Buffer.from(rows(f.database).at(-1).image), png(10, 10));
  const download = await fetch(f.url + mismatch.imageUrl); assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png(10, 10));
  assert.equal(f.database.prepare('SELECT id FROM scene_images WHERE valid = 1').get().id, Number(imageId(original)));
  const badOutputs = [{ data: [] }, { data: [{ b64_json: png().toString('base64') }, { b64_json: png().toString('base64') }] }, { data: [{ b64_json: '%%%' }] }, { data: [{ b64_json: Buffer.from('not image').toString('base64') }] }, { data: [{ b64_json: png().subarray(0, 8).toString('base64') }] }];
  for (const payload of badOutputs) {
    f.mode('result', payload); const before = f.requests.length;
    await assert.rejects(f.generate(), { status: 502 });
    assert.equal(f.requests.length, before + 1); assert.equal(rows(f.database).length, 2);
  }
  f.mode('failure'); await assert.rejects(f.generate(), error => error.status === 502 && !error.message.includes('test-private-key'));
  f.mode('base64'); f.setImage(png());
  f.database.exec("CREATE TRIGGER fail_scene_image BEFORE INSERT ON scene_images BEGIN SELECT RAISE(ABORT, 'simulate disk write failure'); END;");
  const before = f.requests.length;
  const failedSave = await f.post(f.fields()); assert.equal(failedSave.status, 502);
  const recovery = await failedSave.json(); assert.match(recovery.error, /未能保存/);
  assert.equal(recovery.recoveryImage, `data:image/png;base64,${png().toString('base64')}`);
  assert.equal(f.requests.length, before + 1); assert.equal(rows(f.database).length, 2);
  assert.deepEqual(rows(f.database)[0], saved);
  f.database.exec('DROP TRIGGER fail_scene_image');
  assert.equal((await f.generate()).valid, true);
});

test('清空保留付费字节、资料和参考历史；旧页面不能清新图片或新参考，移除后恢复文生图', async t => {
  const f = await fixture(t), original = await f.generate(), scene = f.database.prepare('SELECT * FROM scenes WHERE id = 1').get();
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  const { referenceId: next } = await saveSceneReference(f.database, 1, 1, referenceForm(png(10, 10), String(referenceId)));
  assert.throws(() => clearSceneReference(f.database, 1, 1, new URLSearchParams({ referenceId: String(referenceId) })), { status: 409 });
  const generated = await f.generate(f.fields(1, '2')), count = f.requests.length;
  assert.equal((await f.post({ boardId: imageId(original) }, base + '/clear-image')).status, 409);
  const response = await f.post({ boardId: imageId(generated) }, base + '/clear-image'); assert.equal(response.status, 200);
  assert.equal((await response.json()).cleared, true);
  assert.ok(rows(f.database).every(image => image.cleared === 1));
  assert.deepEqual(f.database.prepare('SELECT * FROM scenes WHERE id = 1').get(), scene);
  for (const result of [original, generated]) {
    const image = await fetch(f.url + result.imageUrl); assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
  }
  assert.equal((await f.post({ boardId: imageId(generated) }, base + '/clear-image')).status, 400);
  assert.equal((await f.post({ referenceId: String(next) }, base + '/clear-reference')).status, 200);
  assert.equal(readSceneReference(f.database, 1), undefined);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM scene_references WHERE cleared = 1').get().n, 2);
  assert.equal(rows(f.database).at(-1).reference_id, next);
  for (const id of [referenceId, next]) assert.equal((await fetch(f.url + `${base}/references/${id}`)).status, 200);
  assert.equal(f.requests.length, count);
  const html = await (await fetch(f.url + detail)).text(); assert.ok(!html.includes(`src="${generated.imageUrl}"`));
  const newer = await f.generate(); assert.equal(newer.valid, true); assert.equal(f.requests.at(-1).path, '/v1/images/generations');
  assert.equal(rows(f.database).at(-1).reference_id, null);
  assert.throws(() => clearSceneImage(f.database, 1, 1, new URLSearchParams({ boardId: imageId(generated) })), { status: 409 });
  assert.equal((await f.post({ boardId: imageId(generated) }, base + '/clear-image')).status, 409);
});

test('页面读取不付费；预览、卡片、旧资料和未通过结果可见；遮罩编辑尚未接入时明确 503 而非整图回退', async t => {
  const f = await fixture(t);
  let html = await (await fetch(f.url + detail)).text();
  assert.match(html, /data-url="\/projects\/1\/scenes\/1\/generate"/);
  assert.match(html, />生成图片<|>生成图片\s*</); assert.match(html, /文生图 · actual-image-model/);
  assert.doesNotMatch(html, /场景图片生成尚未接入|test-private-key|仅适用于.*18/);
  assert.equal(f.requests.length, 0);
  const original = await f.generate();
  html = await (await fetch(f.url + detail)).text(); assert.ok(html.includes(`src="${original.imageUrl}"`));
  assert.ok((await (await fetch(f.url + cards)).text()).includes(`src="${original.imageUrl}"`));
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  html = await (await fetch(f.url + detail)).text();
  assert.match(html, /图生图 API/); assert.match(html, /环境参考生图 · actual-reference-model/);
  assert.doesNotMatch(html, /文生图 · actual-image-model/); assert.ok(html.includes(`data-reference-id="${referenceId}"`));
  assert.match(html, /现有图片对应旧资料/);
  f.setImage(png(10, 10)); const mismatch = await f.generate(f.fields(1, '2'));
  html = await (await fetch(f.url + detail)).text();
  assert.ok(html.includes(`src="${mismatch.imageUrl}"`)); assert.ok(html.includes(`href="${mismatch.imageUrl}"`));
  assert.match(html, /未替换原场景/);
  assert.ok((await (await fetch(f.url + cards)).text()).includes(`src="${original.imageUrl}"`));
  for (const label of ['AI修图', '画笔', '橡皮擦', '撤销', '重做', '清空选区', '下载遮罩', '修改要求']) assert.ok(html.includes(label), label);
  const response = await f.post({ boardId: imageId(mismatch), instruction: '修复砖墙', mask: 'selected-mask' }, base + '/edit-image');
  assert.equal(response.status, 503); assert.match((await response.json()).error, /不会调用模型或回退为整图编辑/);
  assert.equal((await f.post({}, '/projects/2/scenes/1/edit-image')).status, 404);
  assert.equal(f.requests.length, 2); assert.equal(rows(f.database).length, 2);
});

test('schema 13 升级到 14 保留原资源；迁移失败回滚，图片/参考/清空/来源重启后保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-scene-migrate-')), filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = openDatabase(filename);
    database.exec("DROP TABLE look_images; DROP TABLE look_assets; DROP TABLE looks; DROP TABLE production_asset_images; DROP TABLE production_assets; DROP TABLE episode_storyboards; DROP TABLE scene_images; DROP TABLE scene_references; PRAGMA user_version = 13; INSERT INTO projects VALUES (1, '旧项目', '水墨', '16:9'); INSERT INTO scenes (id, project_id, name, description) VALUES (1, 1, '旧场景', '旧布局'); INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '旧角色', 28);");
    database.prepare("INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (1, ?, 'image/png', 16, 9, 1, 'old-revision', 'old-model', 'old-prompt')").run(png());
    const tables = ['projects', 'scenes', 'characters', 'character_boards'];
    const original = tables.map(table => database.prepare(`SELECT * FROM ${table}`).all());
    database.close(); database = undefined;
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 14')) throw new Error('scene migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /scene migration failure/); t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 13);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('scene_images', 'scene_references')").all(), []);
    assert.deepEqual(tables.map(table => database.prepare(`SELECT * FROM ${table}`).all()), original);
    database.close(); database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 16);
    assert.deepEqual(tables.map(table => database.prepare(`SELECT * FROM ${table}`).all()), original);
    assert.deepEqual(rows(database), []);
    const { referenceId } = await saveSceneReference(database, 1, 1, referenceForm());
    database.prepare("INSERT INTO scene_images (scene_id, image, mime, width, height, valid, revision, model, prompt, reference_id) VALUES (1, ?, 'image/png', 16, 9, 1, 'scene-revision', 'scene-model', 'scene-prompt', ?)").run(png(), referenceId);
    clearSceneImage(database, 1, 1, new URLSearchParams({ boardId: '1' }));
    clearSceneReference(database, 1, 1, new URLSearchParams({ referenceId: String(referenceId) }));
    const images = rows(database), references = database.prepare('SELECT * FROM scene_references').all();
    database.close(); database = openDatabase(filename);
    assert.deepEqual(rows(database), images); assert.deepEqual(database.prepare('SELECT * FROM scene_references').all(), references);
    assert.equal(rows(database)[0].cleared, 1); assert.equal(rows(database)[0].reference_id, referenceId);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('真实生成结果重启可读；删除 API 不损失图片，删除场景或项目级联清理历史而不影响其他项目', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-scene-persist-')), filename = join(directory, 'drama.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, filename);
  const { referenceId } = await saveSceneReference(f.database, 1, 1, referenceForm());
  const original = await f.generate(f.fields(1, '2'));
  clearSceneReference(f.database, 1, 1, new URLSearchParams({ referenceId: String(referenceId) }));
  await saveSceneReference(f.database, 1, 1, referenceForm());
  await saveSceneReference(f.database, 1, 2, referenceForm());
  await f.generate(f.fields(2, '2'), 2);
  await saveSceneReference(f.database, 2, 3, referenceForm());
  await f.close();
  const database = openDatabase(filename), app = await listen(t, createApp(database));
  assert.deepEqual(Buffer.from(rows(database)[0].image), png()); assert.equal(rows(database)[0].reference_id, referenceId);
  const image = await fetch(app.url + original.imageUrl); assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
  const postDelete = (path, name) => fetch(app.url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }) });
  assert.equal((await postDelete('/settings/api/2/delete', '环境参考生图')).status, 200);
  assert.equal(rows(database).length, 2); assert.equal(database.prepare('SELECT count(*) AS n FROM scene_references').get().n, 4);
  assert.equal((await postDelete('/projects/2/scenes/1/delete', '旧车站')).status, 404);
  assert.equal((await postDelete(base + '/delete', '旧车站')).status, 200);
  assert.equal(database.prepare('SELECT count(*) AS n FROM scene_references WHERE scene_id = 1').get().n, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM scene_images WHERE scene_id = 1').get().n, 0);
  assert.equal((await fetch(app.url + original.imageUrl)).status, 404);
  assert.equal((await postDelete('/projects/1/delete', '原项目')).status, 200);
  assert.deepEqual(rows(database), []);
  assert.equal(database.prepare('SELECT count(*) AS n FROM scene_references').get().n, 1);
  assert.equal(database.prepare('SELECT project_id FROM scenes').get().project_id, 2);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});
