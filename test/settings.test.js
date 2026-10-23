import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { apiTypes } from '../src/settings.js';

const secret = 'test-private-api-key';
const config = { name: '图片测试接口', type: 'text_to_image', baseUrl: 'http://127.0.0.1:1/v1', apiKey: secret, model: 'ironweave' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aapcAAAAASUVORK5CYII=';
const testFields = record => ({ chargeConfirmed: 'yes', type: record.type, model: record.model, baseUrl: record.baseUrl });

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

async function fixture(t, filename = ':memory:') {
  const database = openDatabase(filename);
  const server = await listen(t, createApp(database));
  const post = (path, fields = {}, options = {}) => fetch(server.url + path, { method: 'POST', body: new URLSearchParams(fields), ...options });
  const get = path => fetch(server.url + path);
  return { ...server, database, post, get };
}

async function saved(response, status = 201) {
  assert.equal(response.status, status);
  return response.json();
}

test('首页设置打开卡片列表和添加入口，无登录；类型下拉筛选四类（旧遮罩只读），新建表单不混入角色板尺寸', async t => {
  const f = await fixture(t);
  assert.match(await (await f.get('/')).text(), /href="\/settings"/);
  assert.deepEqual([...apiTypes.keys()], ['text_to_image', 'llm', 'image_to_image', 'video']);
  const response = await f.get('/settings');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('www-authenticate'), null);
  const list = await response.text();
  assert.match(list, /还没有 API 配置/);
  assert.match(list, /href="\/settings\?new=1"/);
  assert.match(list, /<select id="api-filter" name="type">/);
  assert.doesNotMatch(list, /id="api-config-form"/);
  for (const [type, label] of apiTypes) {
    const filtered = await (await f.get(`/settings?type=${type}`)).text();
    assert.ok(filtered.includes(`href="/settings?new=1&amp;type=${type}"`));
    const html = await (await f.get(`/settings?new=1&type=${type}`)).text();
    assert.ok(html.includes(`<option value="${type}" selected>${label}</option>`));
    for (const name of ['name', 'type', 'baseUrl', 'apiKey', 'model']) assert.ok(html.includes(`name="${name}"`));
    assert.match(html, /name="apiKey" type="password"/);
    assert.match(html, /id="api-config-form" action="\/settings\/api" method="post"/);
    assert.match(html, /id="check-api-connection"[^>]*disabled/);
    assert.match(html, /href="\/settings\?type=/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /测试模型（可能计费）/);
    assert.match(html, /id="api-test-reference-image"[^>]*multiple/);
    assert.doesNotMatch(html, /id="api-protocol"|name="protocol"/);
    assert.match(html, /id="api-test-profile"/);
    assert.match(html, /id="api-test-prompt"/);
    assert.doesNotMatch(html, /只读取 \/models|不会调用模型；不提供模型列表/);
    assert.doesNotMatch(html, /IRONWEAVE_SETTINGS_PASSWORD|登录|name="size"|例如|<!-- API_SETTINGS -->/);
  }
  assert.equal((await f.get('/settings.js')).status, 200);
  for (const suffix of ['?type=unknown', '?type=llm&type=image_edit', '?new=2', '?config=abc', '?config=0', '?config=9007199254740992', '?config=1&config=2', '?config=1&new=1']) assert.equal((await f.get('/settings' + suffix)).status, 404);
  const head = await fetch(f.url + '/settings', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('一条真实配置一张可点击卡片，同类型可添加多条；按 ID 编辑和替换密钥不覆盖其他卡片', async t => {
  const f = await fixture(t);
  const first = await saved(await f.post('/settings/api', { ...config, type: 'llm', model: 'my-image-model', baseUrl: `${config.baseUrl}///` }));
  const second = await saved(await f.post('/settings/api', { ...config, type: 'llm', name: '另一图片接口', apiKey: 'second-secret', model: 'another-model' }));
  assert.notEqual(first.id, second.id);
  assert.equal(first.baseUrl, config.baseUrl);
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.equal(first.apiKey, undefined);
  let html = await (await f.get('/settings')).text();
  assert.equal((html.match(/class="project-card api-config-card"/g) ?? []).length, 2);
  assert.ok(html.includes(`href="/settings?config=${first.id}"`));
  assert.ok(html.includes(`href="/settings?config=${second.id}"`));
  assert.match(html, /图片测试接口|另一图片接口/);
  assert.match(html, /my-image-model/);
  assert.match(html, /another-model/);
  assert.ok(!html.includes(secret));
  assert.ok(!html.includes('second-secret'));
  html = await (await f.get(`/settings?config=${first.id}`)).text();
  assert.ok(html.includes(`data-id="${first.id}"`));
  assert.match(html, /value="图片测试接口"/);
  assert.match(html, /value="my-image-model"/);
  assert.doesNotMatch(html, /another-model|second-secret/);
  await saved(await f.post(`/settings/api/${first.id}`, { ...config, type: 'llm', name: '已改名', apiKey: '', model: 'new-model' }), 200);
  assert.equal(f.database.prepare('SELECT api_key FROM api_configs WHERE id = ?').get(first.id).api_key, secret);
  assert.equal(f.database.prepare('SELECT model FROM api_configs WHERE id = ?').get(second.id).model, 'another-model');
  await saved(await f.post(`/settings/api/${first.id}`, { ...config, type: 'llm', apiKey: 'new-secret' }), 200);
  assert.equal(f.database.prepare('SELECT api_key FROM api_configs WHERE id = ?').get(first.id).api_key, 'new-secret');
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM api_configs').get().count, 2);
});

test('类型下拉只筛选卡片，详情按配置 ID 读取；更换类型保留本条密钥，新建不能借用同类型密钥', async t => {
  const f = await fixture(t);
  const records = [];
  for (const [type, label] of apiTypes) records.push(await saved(await f.post('/settings/api', { ...config, type, ...(type === 'video' ? { protocol: 'ironweave2', model: 'ironweave' } : {}), name: label, apiKey: `${secret}-${type}` })));
  await saved(await f.post('/settings/api', { ...config, name: '第二条文生图' }));
  assert.equal((await f.post('/settings/api', { ...config, apiKey: '' })).status, 400);
  for (const [type] of apiTypes) {
    const html = await (await f.get(`/settings?type=${type}`)).text();
    assert.equal((html.match(/class="project-card api-config-card"/g) ?? []).length, type === 'text_to_image' ? 2 : 1);
    for (const record of records) assert.equal(html.includes(`config=${record.id}&amp;type=${type}`), record.type === type);
  }
  const first = records[0];
  await saved(await f.post(`/settings/api/${first.id}`, { ...config, type: 'image_to_image', apiKey: '' }), 200);
  const row = f.database.prepare('SELECT * FROM api_configs WHERE id = ?').get(first.id);
  assert.equal(row.type, 'image_to_image');
  assert.equal(row.api_key, `${secret}-text_to_image`);
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM api_configs WHERE type = 'image_to_image'").get().count, 2);
});

test('配置名称和模型安全转义，列表、详情、保存响应都不回传密钥', async t => {
  const f = await fixture(t);
  const fields = { ...config, type: 'llm', name: '<script>alert(1)</script> "&', model: '<img src=x onerror=alert(2)> "&' };
  const record = await saved(await f.post('/settings/api', fields));
  assert.ok(!JSON.stringify(record).includes(secret));
  for (const path of ['/settings', `/settings?config=${record.id}`]) {
    const html = await (await f.get(path)).text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
    assert.doesNotMatch(html, /<script>alert|<img src=x/);
    assert.ok(!html.includes(secret));
  }
});

test('配置字段、地址、密钥、模型及 ID 验证，缺失和重复字段拒绝，失败不覆盖已有配置', async t => {
  const f = await fixture(t);
  const record = await saved(await f.post('/settings/api', config));
  const path = `/settings/api/${record.id}`;
  const original = f.database.prepare('SELECT * FROM api_configs').get();
  for (const name of ['', '  ', '字'.repeat(81)]) assert.equal((await f.post(path, { ...config, name })).status, 400);
  for (const type of ['', 'unknown', 'toString']) assert.equal((await f.post(path, { ...config, type })).status, 400);
  for (const baseUrl of ['', 'not-a-url', 'file:///tmp/private', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment', 'https://example.com/a b', `https://example.com/${'x'.repeat(2048)}`]) assert.equal((await f.post(path, { ...config, baseUrl })).status, 400);
  for (const apiKey of ['x'.repeat(4097), 'has space', 'a\nb', '密钥']) assert.equal((await f.post(path, { ...config, apiKey })).status, 400);
  for (const model of ['', 'x'.repeat(201), 'a\nb']) assert.equal((await f.post(path, { ...config, model })).status, 400);
  for (const key of Object.keys(config)) {
    const missing = { ...config };
    delete missing[key];
    assert.equal((await f.post(path, missing)).status, 400);
    const duplicate = new URLSearchParams(config);
    duplicate.append(key, config[key]);
    assert.equal((await f.post(path, duplicate)).status, 400);
  }
  for (const id of ['999999', '9007199254740992']) {
    assert.equal((await f.post(`/settings/api/${id}`, config)).status, 404);
    assert.equal((await f.post(`/settings/api/${id}/check`)).status, 404);
    assert.equal((await f.get(`/settings?config=${id}`)).status, 404);
  }
  assert.deepEqual(f.database.prepare('SELECT * FROM api_configs').get(), original);
});

test('保存和连接检查保留跨站、格式和大小限制，不能公开读取数据文件', async t => {
  const f = await fixture(t);
  const record = await saved(await f.post('/settings/api', config, { headers: { Origin: f.url } }));
  for (const path of ['/settings/api', `/settings/api/${record.id}`, `/settings/api/${record.id}/check`]) {
    assert.equal((await f.post(path, config, { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await f.post(path, config, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.post(path, config, { headers: { 'Content-Type': 'application/json' } })).status, 415);
    assert.equal((await f.post(path, { apiKey: 'x'.repeat(33000) })).status, 413);
    const unsupported = await fetch(f.url + path, { method: 'PUT' });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('allow'), 'POST');
  }
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM api_configs').get().count, 1);
  for (const path of ['/data/drama.sqlite', '/.env', '/src/settings.js']) assert.equal((await f.get(path)).status, 404);
});

test('按配置 ID 和所填模型实际 POST 独立聊天，安全返回文本；不读 /models、不修改配置', async t => {
  const f = await fixture(t), requests = [];
  const provider = await listen(t, createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: `OK ${secret}` } }] }));
  }));
  const record = await saved(await f.post('/settings/api', { ...config, type: 'llm', model: 'my-text-model', baseUrl: `${provider.url}/proxy/v1` }));
  const original = f.database.prepare('SELECT * FROM api_configs').get();
  const text = await saved(await f.post(`/settings/api/${record.id}/check`, testFields(record)), 200);
  assert.equal(text.verified, true); assert.equal(text.kind, 'text'); assert.match(text.text, /^OK/);
  assert.ok(!JSON.stringify(text).includes(secret));
  assert.deepEqual(requests, [{ method: 'POST', path: '/proxy/v1/chat/completions', authorization: `Bearer ${secret}`, body: { model: 'my-text-model', messages: [{ role: 'user', content: 'Reply only with OK.' }], max_tokens: 16, stream: false } }]);
  assert.deepEqual(f.database.prepare('SELECT * FROM api_configs').get(), original);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM api_protocols').get().n, 0);
});

test('旧页面和未确认计费的请求不能偷偷调用模型，配置在其他页面改变或参数重复时拒绝', async t => {
  const f = await fixture(t);
  let calls = 0;
  const provider = await listen(t, createServer((request, response) => { calls++; response.end('{}'); }));
  const record = await saved(await f.post('/settings/api', { ...config, baseUrl: `${provider.url}/v1` }));
  const path = `/settings/api/${record.id}/check`;
  for (const fields of [{}, { ...testFields(record), chargeConfirmed: 'no' }]) assert.equal((await f.post(path, fields)).status, 400);
  for (const key of ['type', 'model', 'baseUrl']) {
    assert.equal((await f.post(path, { ...testFields(record), [key]: 'changed' })).status, 409);
    const duplicate = new URLSearchParams(testFields(record));
    duplicate.append(key, duplicate.get(key));
    assert.equal((await f.post(path, duplicate)).status, 409);
  }
  const duplicate = new URLSearchParams(testFields(record));
  duplicate.append('chargeConfirmed', 'yes');
  assert.equal((await f.post(path, duplicate)).status, 400);
  assert.equal(calls, 0);
});

test('图生图必须上传真实参考文件，坏 multipart、旧字段、伪图片和跨站拒绝不产生请求', async t => {
  const f = await fixture(t); let calls = 0;
  const provider = await listen(t, createServer((_request, response) => { calls++; response.end('{}'); }));
  const record = await saved(await f.post('/settings/api', { ...config, type: 'image_to_image', baseUrl: `${provider.url}/v1` }));
  const path = `/settings/api/${record.id}/check`;
  assert.equal((await f.post(path, testFields(record))).status, 400);
  const body = new FormData(); for (const [key,value] of Object.entries(testFields(record))) body.set(key,value);
  body.set('referenceImages', new Blob(['not a picture'], {type:'image/png'}), 'fake.png');
  assert.equal((await f.post(path, {}, {body})).status, 400);
  body.set('referenceImages', new Blob([Buffer.from(png,'base64')], {type:'text/plain'}), 'wrong.txt');
  assert.equal((await f.post(path, {}, {body})).status, 400);
  body.delete('referenceImages'); body.set('referenceImage',new Blob([Buffer.from(png,'base64')],{type:'image/png'}),'old.png');
  assert.equal((await f.post(path, {}, {body})).status, 400);
  assert.equal((await f.post(path, {}, {headers:{'Content-Type':'multipart/form-data'},body:'broken'})).status,400);
  assert.equal((await f.post(path, {}, {headers:{Origin:'https://other.example'},body:new FormData()})).status,403);
  assert.equal(calls,0); assert.equal(f.database.prepare('SELECT count(*) AS n FROM generation_operations').get().n,0);
});

test('聊天失败、假模型列表、空文本、图片载荷及异步任务 ID 都不算测试成功，错误不回显密钥', async t => {
  const f = await fixture(t);
  let status = 200;
  let raw = '';
  let calls = 0;
  const provider = await listen(t, createServer((request, response) => {
    calls++;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(raw);
  }));
  const record = await saved(await f.post('/settings/api', { ...config, type: 'llm', baseUrl: `${provider.url}/v1` }));
  const path = `/settings/api/${record.id}/check`;
  for (status of [400, 401, 403, 404, 405, 429, 500, 501]) {
    raw = JSON.stringify({ error: { message: `provider error ${secret}` } });
    const response = await f.post(path, testFields(record));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(secret));
    assert.ok(text.includes(`HTTP ${status}`));
  }
  status = 200;
  for (raw of ['not-json', '{"data":{}}', '{"data":[]}', '{"data":[{}]}', '{"data":[{"id":"my-image-model"}]}', '{"task_id":"pending"}', '{"error":{"message":"failed"}}', '{"data":[{"url":"javascript:alert(1)"}]}', '{"data":[{"b64_json":"not base64!"}]}', '{"data":[{"b64_json":"dGV4dA=="}]}', JSON.stringify({ data: [{ url: `https://image.example.test/result?key=${secret}` }] }), JSON.stringify({ data: [{ b64_json: 'x'.repeat(32 * 1024 * 1024) }] })]) {
    const response = await f.post(path, testFields(record));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(secret));
  }
  const textRecord = await saved(await f.post('/settings/api', { ...config, type: 'llm', baseUrl: provider.url }));
  for (raw of ['{}', '{"data":[{"id":"my-image-model"}]}', '{"choices":[{"message":{"content":"  "}}]}', '{"choices":[{"message":{"reasoning_content":"thinking only"}}]}']) assert.equal((await f.post(`/settings/api/${textRecord.id}/check`, testFields(textRecord))).status, 502);
  raw = '{"choices":[{"message":{"content":[{"type":"text","text":"OK"}]}}]}';
  assert.equal((await f.post(`/settings/api/${textRecord.id}/check`, testFields(textRecord))).status, 200);
  assert.equal(calls, 25);
});

test('实际模型请求不跟随重定向泄露密钥，网络失败也不自动重试，并提示可能已经计费', async t => {
  const f = await fixture(t);
  let destinationCalls = 0;
  let sourceCalls = 0;
  const destination = await listen(t, createServer((request, response) => { destinationCalls++; response.end('{}'); }));
  const source = await listen(t, createServer((request, response) => {
    sourceCalls++;
    response.writeHead(302, { Location: `${destination.url}/images/generations` });
    response.end();
  }));
  const record = await saved(await f.post('/settings/api', { ...config, type: 'llm', baseUrl: source.url }));
  assert.equal((await f.post(`/settings/api/${record.id}/check`, testFields(record))).status, 502);
  assert.equal(sourceCalls, 1);
  assert.equal(destinationCalls, 0);
  await source.close();
  const response = await f.post(`/settings/api/${record.id}/check`, testFields(record));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /可能已提交并计费/);
  assert.equal(sourceCalls, 1);
});

test('配置卡片与 ID 在重启后保留，重复类型不覆盖，原角色资料不变', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-settings-'));
  try {
    const filename = join(directory, 'drama.sqlite');
    const first = await fixture(t, filename);
    first.database.exec("INSERT INTO projects VALUES (1, '原项目', '写实电影', '9:16'); INSERT INTO seasons VALUES (1, 1, '原季', 1); INSERT INTO characters (project_id, name, age) VALUES (1, '原角色', 28)");
    const records = [];
    for (const [type, label] of apiTypes) records.push(await saved(await first.post('/settings/api', { ...config, type, ...(type === 'video' ? { protocol: 'ironweave2', model: 'ironweave' } : {}), name: label, model: type === 'llm' ? 'chat-model' : 'ironweave' })));
    records.push(await saved(await first.post('/settings/api', { ...config, name: '另一条文生图' })));
    await first.close();
    const second = await fixture(t, filename);
    assert.equal(second.database.prepare('SELECT count(*) AS count FROM api_configs').get().count, 5);
    assert.equal(second.database.prepare('SELECT name FROM characters').get().name, '原角色');
    const list = await (await second.get('/settings')).text();
    assert.equal((list.match(/class="project-card api-config-card"/g) ?? []).length, 5);
    for (const record of records) {
      const html = await (await second.get(`/settings?config=${record.id}`)).text();
      assert.ok(!html.includes(secret));
      assert.ok(html.includes(`value="${record.name}"`));
    }
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('旧遮罩卡片只读停用，记录及密钥保留、不新建不测试不暗改类型', async t => {
  const f=await fixture(t);
  f.database.prepare("INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES(?,'image_edit',?,?,?)").run('旧遮罩',config.baseUrl,secret,'old-mask');
  const before=f.database.prepare('SELECT * FROM api_configs').get();
  const list=await (await f.get('/settings')).text(); assert.match(list,/遮罩编辑配置（已停用）/); assert.doesNotMatch(list,/undefined/);
  const detail=await (await f.get(`/settings?config=${before.id}`)).text(); assert.match(detail,/原记录和历史作品保留/); assert.match(detail,/old-mask/); assert.doesNotMatch(detail,/id="api-config-form"|id="check-api-connection"/); assert.ok(!detail.includes(secret));
  const filtered=await (await f.get('/settings?type=image_edit')).text(); assert.doesNotMatch(filtered,/href="[^"]*new=1/);
  assert.equal((await f.get('/settings?new=1&type=image_edit')).status,400);
  assert.equal((await f.post('/settings/api',{...config,type:'image_edit'})).status,400);
  assert.equal((await f.post(`/settings/api/${before.id}`,{...config,type:'image_to_image'})).status,400);
  assert.equal((await f.post(`/settings/api/${before.id}/check`,{...testFields({...config,type:'image_edit',model:'old-mask'})})).status,400);
  assert.deepEqual(f.database.prepare('SELECT * FROM api_configs').get(),before);
});


test('设置测试 multipart 单独允许超过旧 6 MiB 上限，但合计超过 32 MiB 不会创建操作', async t => {
  const f=await fixture(t), record=await saved(await f.post('/settings/api',{...config,type:'image_to_image'}));
  const body=new FormData(); for(const [key,value] of Object.entries(testFields(record))) body.set(key,value);
  body.set('referenceImages',new Blob([Buffer.alloc(6*1024*1024+1)],{type:'image/png'}),'bad.png');
  const path=`/settings/api/${record.id}/check`;
  assert.equal((await f.post(path,{}, {body})).status,400);
  body.set('referenceImages',new Blob([Buffer.alloc(32*1024*1024+1)],{type:'image/png'}),'large.png');
  assert.equal((await f.post(path,{}, {body})).status,413);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM generation_operations').get().n,0);
});

test('已保存视频参数实际详情页可渲染数字 frames/fps 和五图测试入口', async t => {
  const f=await fixture(t);
  const record=await saved(await f.post('/settings/api',{...config,type:'video',videoProfiles:JSON.stringify([{size:'1024x576',frames:124,fps:24}])}));
  const response=await f.get(`/settings?config=${record.id}`);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/<option value="0">1024x576 · 124 帧 · 24 fps<\/option>/);
  assert.match(html,/<div id="api-test-reference" >/);
  assert.match(html,/name="referenceImages" type="file" multiple/);
  assert.match(html,/<div id="api-test-video" >/);
  assert.match(html,/href="\/operations"/);
  assert.ok(!html.includes(secret));
});
