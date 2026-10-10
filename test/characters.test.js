import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { characterFields } from '../src/characters.js';

const form = values => ({ ...Object.fromEntries(characterFields.map(field => [field.key, ''])), ...values });

async function fixture(t, filename = ':memory:') {
  const database = openDatabase(filename);
  const server = createApp(database);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  t.after(close);
  const post = (path, fields, options = {}) => fetch(url + path, { method: 'POST', body: new URLSearchParams(fields), ...options });
  const get = path => fetch(url + path);
  const project = async () => (await post('/projects', { name: '角色测试', style: '国风水墨', aspectRatio: '9:16' })).json();
  return { database, post, get, project, close, url };
}

async function saved(response, status = 201) {
  assert.equal(response.status, status);
  return response.json();
}

test('角色从名称建档，卡片进入详情；模板比例不继承项目竖屏比例，提供基础角色板下面的实际生图入口，未知年龄时禁用', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const path = `/projects/${p.id}/characters`;
  const empty = await (await f.get(`/projects/${p.id}?resource=characters`)).text();
  assert.match(empty, /data-title="创建角色" data-name=""/);
  assert.doesNotMatch(empty, /例如/);
  const c = await saved(await f.post(path, { name: '  林秋  ' }));
  assert.equal(c.name, '林秋');
  const row = f.database.prepare('SELECT * FROM characters WHERE id = ?').get(c.id);
  assert.equal(row.project_id, p.id);
  assert.equal(row.age, null);
  assert.equal(row.face_features, '');
  const list = await (await f.get(c.redirect)).text();
  assert.match(list, /<h3>林秋<\/h3>/);
  assert.ok(list.includes(`href="/projects/${p.id}?resource=characters&amp;character=${c.id}"`));
  assert.match(list, /未生成角色板/);
  assert.doesNotMatch(list, /角色分页/);
  const html = await (await f.get(`${c.redirect}&character=${c.id}`)).text();
  assert.match(html, /<h2 id="resource-title">林秋<\/h2>/);
  assert.match(html, /href="\?resource=characters" aria-current="page"/);
  assert.match(html, /基础角色板<\/h3><span>16:9<\/span>/);
  assert.doesNotMatch(html, /class="character-style"|先保存角色资料。点击并确认|资料保存不会调用 AI|这份基础角色板模板仅适用于/);
  assert.match(html, /保存资料/);
  for (const field of characterFields) assert.ok(html.includes(`name="${field.key}"`));
  assert.match(html, /id="generate-character-image"[^>]*disabled>生成图片/);
  assert.match(html, /id="character-image-api"/);
  assert.doesNotMatch(html, /name="(?:costume|props)"|例如/);
});

test('全部基础外观可修改、留空和保存，年龄为 0、未成年及未知均可建档，重命名后列表同步', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const c = await saved(await f.post(`/projects/${p.id}/characters`, { name: '角色' }));
  const values = form({ name: ' 新名称 ', age: '17', genderPresentation: '中性外形', skinTone: '自然肤色', faceFeatures: '圆脸，眉骨明显', hairStyle: '短卷发', hairColor: '黑色', height: '1.72 米', bodyBuild: '偏瘦', bodyProportions: '肩窄，腿长', identityFeatures: '左眉旧疤', appearanceNotes: '右脸颊有浅色胎记' });
  const result = await saved(await f.post(`/projects/${p.id}/characters/${c.id}`, values), 200);
  const row = f.database.prepare('SELECT * FROM characters WHERE id = ?').get(c.id);
  for (const field of characterFields) assert.equal(row[field.column], field.key === 'age' ? 17 : values[field.key].trim());
  assert.match(await (await f.get(result.redirect)).text(), /value="新名称"/);
  assert.match(await (await f.get(`/projects/${p.id}?resource=characters`)).text(), /<h3>新名称<\/h3>/);
  await saved(await f.post(`/projects/${p.id}/characters/${c.id}`, form({ name: '新名称', age: '0' })), 200);
  assert.equal(f.database.prepare('SELECT age FROM characters WHERE id = ?').get(c.id).age, 0);
  await saved(await f.post(`/projects/${p.id}/characters/${c.id}`, form({ name: '新名称' })), 200);
  assert.equal(f.database.prepare('SELECT age FROM characters WHERE id = ?').get(c.id).age, null);
  assert.equal(f.database.prepare('SELECT hair_style FROM characters WHERE id = ?').get(c.id).hair_style, '');
});

test('名称、所有字段长度、整数年龄及重复或缺失字段均验证，失败不覆盖已有资料', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const path = `/projects/${p.id}/characters`;
  for (const name of ['', '  ', '字'.repeat(81)]) assert.equal((await f.post(path, { name })).status, 400);
  const duplicate = new URLSearchParams({ name: '角色' });
  duplicate.append('name', '另一个');
  assert.equal((await f.post(path, duplicate)).status, 400);
  const c = await saved(await f.post(path, { name: '保留资料' }));
  const update = `${path}/${c.id}`;
  await saved(await f.post(update, form({ name: '保留资料', faceFeatures: '原有五官' })), 200);
  const original = f.database.prepare('SELECT * FROM characters WHERE id = ?').get(c.id);
  for (const field of characterFields.filter(field => field.max)) {
    assert.equal((await f.post(update, form({ name: '不会保存', [field.key]: 'x'.repeat(field.max + 1) }))).status, 400);
  }
  for (const age of ['-1', '1.5', '18岁', '1e2', '9007199254740992']) assert.equal((await f.post(update, form({ name: '不会保存', age }))).status, 400);
  assert.equal((await f.post(update, { name: '缺失其他字段' })).status, 400);
  const fullDuplicate = new URLSearchParams(form({ name: '不会保存' }));
  fullDuplicate.append('faceFeatures', '重复');
  assert.equal((await f.post(update, fullDuplicate)).status, 400);
  assert.deepEqual(f.database.prepare('SELECT * FROM characters WHERE id = ?').get(c.id), original);
});

test('角色只属于当前项目，跨项目读取和更新、不存在的项目与超范围 ID 均拒绝', async t => {
  const f = await fixture(t);
  const a = await f.project();
  const b = await f.project();
  const c = await saved(await f.post(`/projects/${b.id}/characters`, { name: 'B 的角色' }));
  for (const path of [`/projects/${a.id}/characters/${c.id}`, '/projects/999999/characters', `/projects/${a.id}/characters/9007199254740992`]) {
    assert.equal((await f.post(path, form({ name: '越界修改' }))).status, 404);
  }
  for (const id of [c.id, 'abc', '0', '-1', '1e0', '9007199254740992']) assert.equal((await f.get(`/projects/${a.id}?resource=characters&character=${id}`)).status, 404);
  const list = await (await f.get(`/projects/${a.id}?resource=characters`)).text();
  assert.doesNotMatch(list, /B 的角色/);
  assert.equal((await f.get(`/projects/${b.id}?resource=characters&character=${c.id}&character=${c.id}`)).status, 404);
  await saved(await f.post(`/projects/${b.id}/characters/${c.id}`, { ...form({ name: 'B 的角色' }), projectId: a.id }), 200);
  assert.equal(f.database.prepare('SELECT project_id FROM characters WHERE id = ?').get(c.id).project_id, b.id);
});

test('写入沿用跨站与格式限制，中文长资料可以完整保存，超大请求拒绝', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const path = `/projects/${p.id}/characters`;
  const c = await saved(await f.post(path, { name: '角色' }, { headers: { Origin: f.url } }));
  for (const target of [path, `${path}/${c.id}`]) {
    assert.equal((await f.post(target, form({ name: '拒绝' }), { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await f.post(target, form({ name: '拒绝' }), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.post(target, form({ name: '拒绝' }), { headers: { 'Content-Type': 'application/json' } })).status, 415);
  }
  assert.equal((await f.post(path, { name: 'x'.repeat(9000) })).status, 413);
  const long = Object.fromEntries(characterFields.map(field => [field.key, field.max ? '字'.repeat(field.max) : '18']));
  assert.ok(new URLSearchParams(long).toString().length > 8192);
  await saved(await f.post(`${path}/${c.id}`, long), 200);
  assert.equal(f.database.prepare('SELECT appearance_notes FROM characters WHERE id = ?').get(c.id).appearance_notes, long.appearanceNotes);
  assert.equal((await f.post(`${path}/${c.id}`, { ...long, appearanceNotes: 'x'.repeat(66000) })).status, 413);
});

test('名称、画风和外观字段安全转义，名称搜索只匹配字面内容且保持当前项目范围', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const name = '<script>alert(1)</script> $&';
  const c = await saved(await f.post(`/projects/${p.id}/characters`, { name }));
  await saved(await f.post(`/projects/${p.id}/characters/${c.id}`, form({ name, faceFeatures: '</textarea><img src=x onerror=alert(2)>' })), 200);
  const detail = await (await f.get(`/projects/${p.id}?resource=characters&character=${c.id}`)).text();
  assert.match(detail, /&lt;script&gt;alert\(1\)&lt;\/script&gt; \$&amp;/);
  assert.match(detail, /&lt;\/textarea&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.doesNotMatch(detail, /<script>alert|<img src=x/);
  for (const name of ['Scout', '含%标记', '含_标记']) await saved(await f.post(`/projects/${p.id}/characters`, { name }));
  for (const [q, expected] of [['scout', 'Scout'], ['%', '含%标记'], ['_', '含_标记']]) {
    const html = await (await f.get(`/projects/${p.id}?resource=characters&q=${encodeURIComponent(q)}`)).text();
    assert.ok(html.includes(`<h3>${expected}</h3>`));
    assert.equal((html.match(/class="project-card character-card"/g) ?? []).length, 1);
  }
  const html = await (await f.get(`/projects/${p.id}?resource=characters&q=${encodeURIComponent('\"/><script>alert(3)</script>')}`)).text();
  assert.doesNotMatch(html, /<script>alert\(3\)/);
  assert.match(html, /没有匹配的角色/);
});

test('每页 50 个，超过 50 个才分页；筛选保留在翻页链接，非法页码拒绝，超出范围归到末页', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const other = await f.project();
  const insert = f.database.prepare('INSERT INTO characters (project_id, name) VALUES (?, ?)');
  for (let i = 1; i <= 50; i++) insert.run(p.id, `目标角色${String(i).padStart(2, '0')}`);
  insert.run(other.id, '目标其他项目');
  const base = `/projects/${p.id}?resource=characters`;
  let html = await (await f.get(base)).text();
  assert.equal((html.match(/class="project-card character-card"/g) ?? []).length, 50);
  assert.doesNotMatch(html, /角色分页/);
  insert.run(p.id, '目标角色51');
  html = await (await f.get(`${base}&q=${encodeURIComponent('目标')}`)).text();
  assert.equal((html.match(/class="project-card character-card"/g) ?? []).length, 50);
  assert.match(html, /角色分页/);
  assert.ok(html.includes(`q=${encodeURIComponent('目标')}&amp;page=2`));
  assert.doesNotMatch(html, /目标其他项目|<h3>目标角色01<\/h3>/);
  html = await (await f.get(`${base}&q=${encodeURIComponent('目标')}&page=2`)).text();
  assert.equal((html.match(/class="project-card character-card"/g) ?? []).length, 1);
  assert.match(html, /<h3>目标角色01<\/h3>/);
  assert.match(await (await f.get(`${base}&page=9999`)).text(), /第 2 \/ 2 页/);
  for (const page of ['0', '-1', '1e0', '1.5', '9007199254740992']) assert.equal((await f.get(`${base}&page=${page}`)).status, 400);
  for (const suffix of ['&page=1&page=2', '&q=a&q=b', `&q=${'x'.repeat(81)}`]) assert.equal((await f.get(base + suffix)).status, 400);
  html = await (await f.get(`${base}&q=${encodeURIComponent('不存在')}&page=2`)).text();
  assert.match(html, /没有匹配的角色/);
  assert.doesNotMatch(html, /角色分页/);
});

test('角色资料在重启后保留，不重复建档，不影响原项目、季和集', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-characters-'));
  try {
    const filename = join(directory, 'drama.sqlite');
    const first = await fixture(t, filename);
    const p = await first.project();
    const c = await saved(await first.post(`/projects/${p.id}/characters`, { name: '持久角色' }));
    await saved(await first.post(`/projects/${p.id}/characters/${c.id}`, form({ name: '持久角色', age: '28', identityFeatures: '左眉旧疤' })), 200);
    await first.close();
    const second = await fixture(t, filename);
    assert.equal(second.database.prepare('SELECT count(*) AS count FROM characters').get().count, 1);
    assert.equal(second.database.prepare('SELECT identity_features FROM characters WHERE id = ?').get(c.id).identity_features, '左眉旧疤');
    assert.equal(second.database.prepare('SELECT count(*) AS count FROM seasons WHERE project_id = ?').get(p.id).count, 1);
    assert.match(await (await second.get(`/projects/${p.id}?resource=characters&character=${c.id}`)).text(), /左眉旧疤/);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
