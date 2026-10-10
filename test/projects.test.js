import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

const database = openDatabase(':memory:');
const server = createApp(database);
let baseUrl;

async function start(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const stop = server => new Promise(resolve => server.close(resolve));

before(async () => { baseUrl = await start(server); });
after(() => stop(server));

function createProject(fields, options = {}) {
  return fetch(`${baseUrl}/projects`, {
    method: 'POST',
    body: new URLSearchParams(fields),
    ...options,
  });
}

test('创建整部短剧，保存名称、自由填写的风格与画面比例，并显示卡片', async () => {
  const response = await createProject({ name: ' 假掌门 ', style: ' 东方奇幻电影 ', aspectRatio: '16:9' });
  assert.equal(response.status, 201);
  const project = await response.json();
  assert.ok(Number.isInteger(project.id));
  assert.equal(project.name, '假掌门');
  assert.equal(project.style, '东方奇幻电影');
  assert.equal(project.aspectRatio, '16:9');
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /class="project-card"/);
  assert.match(html, /假掌门/);
  assert.match(html, /东方奇幻电影/);
  assert.match(html, /16:9/);
  assert.doesNotMatch(html, /还没有短剧项目/);
});

test('拒绝空字段、过长字段、未知比例和重复字段，且不写入数据库', async () => {
  const countBefore = database.prepare('SELECT count(*) AS count FROM projects').get().count;
  const valid = { name: '测试短剧', style: '写实电影', aspectRatio: '9:16' };
  for (const fields of [
    { ...valid, name: '   ' },
    { ...valid, style: '' },
    { ...valid, name: '字'.repeat(81) },
    { ...valid, style: '字'.repeat(121) },
    { ...valid, aspectRatio: '5:7' },
    { name: valid.name, style: valid.style },
  ]) {
    const response = await createProject(fields);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  const duplicate = new URLSearchParams(valid);
  duplicate.append('name', '另一个名字');
  assert.equal((await createProject(duplicate)).status, 400);
  assert.equal(database.prepare('SELECT count(*) AS count FROM projects').get().count, countBefore);
});

test('六种比例均可选择、保存并显示，项目文字在 HTML 中被转义', async () => {
  for (const aspectRatio of ['9:16', '16:9', '21:9', '4:3', '3:4', '1:1']) {
    const response = await createProject({ name: '<script>alert(1)</script>', style: '<b>自定义 & 风格</b>', aspectRatio });
    assert.equal(response.status, 201);
    const project = await response.json();
    assert.equal(project.aspectRatio, aspectRatio);
    assert.equal(database.prepare('SELECT aspect_ratio FROM projects WHERE id = ?').get(project.id).aspect_ratio, aspectRatio);
    const html = await (await fetch(baseUrl)).text();
    assert.ok(html.includes(`<option value="${aspectRatio}">`));
    assert.ok(html.includes(`<span>${aspectRatio}</span>`));
  }
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;自定义 &amp; 风格&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('拒绝跨站提交、不支持的请求格式与超大请求', async () => {
  const fields = { name: '测试', style: '写实', aspectRatio: '9:16' };
  for (const origin of ['https://other.example', 'null', 'invalid-origin']) {
    assert.equal((await createProject(fields, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await createProject(fields, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await createProject(fields, { headers: { Origin: baseUrl } })).status, 201);
  assert.equal((await createProject(fields, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await createProject({ ...fields, name: 'x'.repeat(9000) })).status, 413);
});

test('关闭并重新打开数据库后，已创建的短剧仍显示在主页', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-projects-'));
  const filename = join(directory, 'projects.sqlite');
  let currentServer;
  try {
    currentServer = createApp(openDatabase(filename));
    let url = await start(currentServer);
    const response = await fetch(`${url}/projects`, {
      method: 'POST',
      body: new URLSearchParams({ name: '持久保存的短剧', style: '国风水墨', aspectRatio: '1:1' }),
    });
    assert.equal(response.status, 201);
    await stop(currentServer);
    currentServer = createApp(openDatabase(filename));
    url = await start(currentServer);
    assert.match(await (await fetch(url)).text(), /持久保存的短剧/);
  } finally {
    if (currentServer?.listening) await stop(currentServer);
    await rm(directory, { recursive: true, force: true });
  }
});
