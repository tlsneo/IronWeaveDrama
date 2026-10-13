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
  assert.ok(html.includes(`href="/projects/${project.id}"`));
  assert.match(html, /假掌门/);
  assert.match(html, /东方奇幻电影/);
  assert.match(html, /16:9/);
  assert.doesNotMatch(html, /还没有短剧项目/);
});

test('项目卡片进入对应创作页，可直接访问或刷新，项目资料相互隔离', async () => {
  const first = await (await createProject({ name: '第一部短剧', style: '国风水墨', aspectRatio: '21:9' })).json();
  const second = await (await createProject({ name: '第二部短剧', style: '日系动漫', aspectRatio: '3:4' })).json();
  for (const project of [first, second]) {
    const response = await fetch(`${baseUrl}/projects/${project.id}?source=library`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes(`<h1>${project.name}</h1>`));
    assert.ok(html.includes(`<dd>${project.style}</dd>`));
    assert.ok(html.includes(`<dd>${project.aspectRatio}</dd>`));
    assert.match(html, /资源库/);
    assert.match(html, /<summary>创作<\/summary>/);
    assert.match(html, /分季／分集管理/);
    assert.match(html, /第一季/);
    assert.match(html, /class="studio-header"/);
    assert.match(html, /class="studio-sidebar"/);
    assert.match(html, /class="studio-main"/);
    assert.match(html, /<details class="resource-navigation" open>/);
    assert.doesNotMatch(html, /project-breadcrumb|整部短剧项目/);
    assert.match(html, /class="back-link" href="\/"/);
    assert.match(html, /id="theme-toggle"/);
    assert.doesNotMatch(html, /src="\/projects.js"/);
    assert.ok(!html.includes(project.id === first.id ? second.name : first.name));
    const head = await fetch(`${baseUrl}/projects/${project.id}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('五类资源入口可切换，当前分类被选中，折叠菜单保持原生键盘操作', async () => {
  const project = await (await createProject({ name: '分类工作台', style: '写实电影', aspectRatio: '9:16' })).json();
  for (const [type, name] of [['characters', '角色'], ['scenes', '场景'], ['props', '道具'], ['costumes', '服饰'], ['looks', '定妆']]) {
    const response = await fetch(`${baseUrl}/projects/${project.id}?resource=${type}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`<h2 id="resource-title">${name}</h2>`));
    assert.ok(html.includes(['characters', 'scenes'].includes(type) ? `还没有${name}资源` : `尚无${name}`));
    assert.ok(html.includes(`href="?resource=${type}" aria-current="page"`));
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, /<summary>资源库<\/summary>/);
    assert.match(html, /演员资源/);
    assert.match(html, /美术资源/);
    assert.doesNotMatch(html, /<!-- (?:PROJECT|RESOURCE|CHARACTERS|SCENES|PROPS|COSTUMES|LOOKS)_/);
  }
  for (const type of ['unknown', 'toString', '']) {
    assert.equal((await fetch(`${baseUrl}/projects/${project.id}?resource=${type}`)).status, 404);
  }
});

test('不存在或格式非法的项目地址返回 404', async () => {
  for (const id of ['999999', '0', '-1', 'abc', '1.5', '1e0', '9007199254740992']) {
    assert.equal((await fetch(`${baseUrl}/projects/${id}`)).status, 404);
  }
});

test('创作页安全展示特殊字符，不执行项目资料中的 HTML 或替换标记', async () => {
  const project = await (await createProject({ name: '<script>alert(1)</script> $&', style: '<b>自定义 & 风格</b>', aspectRatio: '4:3' })).json();
  const html = await (await fetch(`${baseUrl}/projects/${project.id}`)).text();
  assert.match(html, /<h1>&lt;script&gt;alert\(1\)&lt;\/script&gt; \$&amp;<\/h1>/);
  assert.match(html, /<dd>&lt;b&gt;自定义 &amp; 风格&lt;\/b&gt;<\/dd>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<!-- PROJECT_/);
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
    const project = await response.json();
    await stop(currentServer);
    currentServer = createApp(openDatabase(filename));
    url = await start(currentServer);
    assert.match(await (await fetch(url)).text(), /持久保存的短剧/);
    const detail = await fetch(`${url}/projects/${project.id}`);
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /<h1>持久保存的短剧<\/h1>/);
  } finally {
    if (currentServer?.listening) await stop(currentServer);
    await rm(directory, { recursive: true, force: true });
  }
});
