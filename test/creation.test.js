import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

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
  const post = (path, fields, options = {}) => fetch(`${url}${path}`, { method: 'POST', body: new URLSearchParams(fields), ...options });
  const get = path => fetch(`${url}${path}`);
  async function project(name = '创作测试') {
    const response = await post('/projects', { name, style: '写实电影', aspectRatio: '9:16' });
    assert.equal(response.status, 201);
    const result = await response.json();
    result.season = database.prepare('SELECT * FROM seasons WHERE project_id = ?').get(result.id);
    return result;
  }
  return { database, url, close, post, get, project };
}

async function saved(response, status = 201) {
  assert.equal(response.status, status);
  return response.json();
}

test('新项目原子创建第一季，创作默认进入分季管理，资源入口仍可访问', async t => {
  const f = await fixture(t);
  const project = await f.project();
  assert.equal(project.season.name, '第一季');
  assert.equal(project.season.position, 1);
  const html = await (await f.get(`/projects/${project.id}`)).text();
  assert.match(html, /href="\?view=scripts"/);
  assert.match(html, /href="\?view=seasons" aria-current="page"/);
  assert.match(html, /第一季/);
  assert.match(html, /本季还没有集/);
  assert.match(html, /data-name="第1集"/);
  assert.match(html, /src="\/studio.js"/);
  assert.equal((await f.get('/studio.js')).status, 200);
  assert.match(await (await f.get(`/projects/${project.id}?resource=characters`)).text(), /还没有角色资源/);
});

test('创建季、重命名和上下移动，顺序改变但已有集的归属不变', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const second = await saved(await f.post(`/projects/${p.id}/seasons`, { name: ' 第二季 ' }));
  const third = await saved(await f.post(`/projects/${p.id}/seasons`, { name: '第三季' }));
  const episode = await saved(await f.post(`/projects/${p.id}/episodes`, { name: '续篇开场', seasonId: second.id }));
  await saved(await f.post(`/projects/${p.id}/seasons/${second.id}`, { name: '续篇' }), 200);
  await saved(await f.post(`/projects/${p.id}/seasons/${second.id}/move`, { direction: 'up' }), 200);
  const order = () => f.database.prepare('SELECT id FROM seasons WHERE project_id = ? ORDER BY position, id').all(p.id).map(item => item.id);
  assert.deepEqual(order(), [second.id, p.season.id, third.id]);
  assert.equal(f.database.prepare('SELECT season_id FROM episodes WHERE id = ?').get(episode.id).season_id, second.id);
  const html = await (await f.get(second.redirect)).text();
  assert.ok(html.indexOf('class="season-name">续篇') < html.indexOf('class="season-name">第一季'));
  assert.match(html, /续篇开场/);
  await saved(await f.post(`/projects/${p.id}/seasons/${second.id}/move`, { direction: 'up' }), 200);
  assert.deepEqual(order(), [second.id, p.season.id, third.id]);
  await saved(await f.post(`/projects/${p.id}/seasons/${second.id}/move`, { direction: 'down' }), 200);
  assert.deepEqual(order(), [p.season.id, second.id, third.id]);
});

test('集在所属季内创建、改名、排序，剧本入口与分集入口进入同一个本集页面', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const one = await saved(await f.post(`/projects/${p.id}/episodes`, { name: '第一集', seasonId: p.season.id }));
  const two = await saved(await f.post(`/projects/${p.id}/episodes`, { name: '第二集', seasonId: p.season.id }));
  const otherSeason = await saved(await f.post(`/projects/${p.id}/seasons`, { name: '另一季' }));
  const other = await saved(await f.post(`/projects/${p.id}/episodes`, { name: '另一季开场', seasonId: otherSeason.id }));
  await saved(await f.post(`/projects/${p.id}/episodes/${two.id}`, { name: '新的开场' }), 200);
  await saved(await f.post(`/projects/${p.id}/episodes/${two.id}/move`, { direction: 'up' }), 200);
  const rows = f.database.prepare('SELECT id FROM episodes WHERE season_id = ? ORDER BY position').all(p.season.id);
  assert.deepEqual(rows.map(item => item.id), [two.id, one.id]);
  assert.equal(f.database.prepare('SELECT position FROM episodes WHERE id = ?').get(other.id).position, 1);
  for (const view of ['seasons', 'scripts']) {
    const html = await (await f.get(`/projects/${p.id}?view=${view}`)).text();
    assert.ok(html.includes(`href="/projects/${p.id}?view=episode&episode=${two.id}"`));
    assert.match(html, /新的开场/);
  }
  const detail = await f.get(`/projects/${p.id}?view=episode&episode=${two.id}`);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.match(html, /<h2 id="resource-title">新的开场<\/h2>/);
  assert.match(html, /本集剧本/);
  assert.match(html, /分镜/);
  assert.match(html, /href="\?view=seasons" aria-current="page"/);
  assert.doesNotMatch(html, /<!-- (?:PROJECT|WORKSPACE|RESOURCE|SEASONS|SCRIPTS)_/);
});

test('名称、所属季和排序方向均在服务端验证，失败不写入数据', async t => {
  const f = await fixture(t);
  const p = await f.project();
  for (const name of ['', '  ', '字'.repeat(81)]) {
    assert.equal((await f.post(`/projects/${p.id}/seasons`, { name })).status, 400);
    assert.equal((await f.post(`/projects/${p.id}/episodes`, { name, seasonId: p.season.id })).status, 400);
    assert.equal((await f.post(`/projects/${p.id}/seasons/${p.season.id}`, { name })).status, 400);
  }
  const duplicate = new URLSearchParams({ name: '名称' });
  duplicate.append('name', '重复');
  assert.equal((await f.post(`/projects/${p.id}/seasons`, duplicate)).status, 400);
  for (const seasonId of ['', '0', '-1', '1e0', '9007199254740992']) {
    assert.equal((await f.post(`/projects/${p.id}/episodes`, { name: '测试集', seasonId })).status, 400);
  }
  assert.equal((await f.post(`/projects/${p.id}/seasons/${p.season.id}/move`, { direction: 'left' })).status, 400);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM seasons WHERE project_id = ?').get(p.id).count, 1);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM episodes').get().count, 0);
});

test('项目之间隔离，不能把集加入其他项目的季，不能改名或移动其他项目的季和集', async t => {
  const f = await fixture(t);
  const a = await f.project('项目 A');
  const b = await f.project('项目 B');
  const episode = await saved(await f.post(`/projects/${b.id}/episodes`, { name: 'B 的一集', seasonId: b.season.id }));
  for (const [path, fields] of [
    [`/projects/${a.id}/episodes`, { name: '跨项目集', seasonId: b.season.id }],
    [`/projects/${a.id}/seasons/${b.season.id}`, { name: '越界改名' }],
    [`/projects/${a.id}/seasons/${b.season.id}/move`, { direction: 'up' }],
    [`/projects/${a.id}/episodes/${episode.id}`, { name: '越界改名' }],
    [`/projects/${a.id}/episodes/${episode.id}/move`, { direction: 'up' }],
    ['/projects/999999/seasons', { name: '不存在的项目' }],
    [`/projects/${a.id}/episodes/9007199254740992`, { name: '越界 ID' }],
  ]) assert.equal((await f.post(path, fields)).status, 404);
  assert.equal((await f.get(`/projects/${a.id}?view=episode&episode=${episode.id}`)).status, 404);
  assert.equal((await f.get(`/projects/${a.id}?view=episode&episode=invalid`)).status, 404);
  assert.equal((await f.get(`/projects/${a.id}?view=unknown`)).status, 404);
  assert.equal(f.database.prepare('SELECT name FROM episodes WHERE id = ?').get(episode.id).name, 'B 的一集');
});

test('新增写入入口保留跨站、格式和请求大小限制，特殊名称安全展示', async t => {
  const f = await fixture(t);
  const p = await f.project();
  const path = `/projects/${p.id}/seasons`;
  assert.equal((await f.post(path, { name: '被拒绝' }, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.post(path, { name: '被拒绝' }, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.post(path, { name: 'x'.repeat(9000) })).status, 413);
  const season = await saved(await f.post(path, { name: '<img src=x onerror=alert(1)> "$&' }, { headers: { Origin: f.url } }));
  await saved(await f.post(`/projects/${p.id}/episodes`, { name: '<script>alert(2)</script>', seasonId: season.id }));
  for (const view of ['scripts', 'seasons']) {
    const html = await (await f.get(`/projects/${p.id}?view=${view}`)).text();
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img src=x|<script>alert\(2\)/);
  }
});

test('创建第一季失败时不留下半完成项目，移动失败时两边顺序均回滚', async t => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  f.database.exec("CREATE TEMP TRIGGER fail_default_season BEFORE INSERT ON seasons BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await f.post('/projects', { name: '不会留下', style: '写实电影', aspectRatio: '9:16' })).status, 500);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM projects').get().count, 0);
  f.database.exec('DROP TRIGGER fail_default_season');
  const p = await f.project();
  const second = await saved(await f.post(`/projects/${p.id}/seasons`, { name: '第二季' }));
  f.database.exec(`CREATE TEMP TRIGGER fail_swap BEFORE UPDATE ON seasons WHEN NEW.id = ${p.season.id} BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  assert.equal((await f.post(`/projects/${p.id}/seasons/${second.id}/move`, { direction: 'up' })).status, 500);
  assert.deepEqual(f.database.prepare('SELECT position FROM seasons WHERE project_id = ? ORDER BY id').all(p.id).map(row => row.position), [1, 2]);
});

test('季和集的名称、顺序与归属在重启后保留，默认季不会重复创建', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-creation-'));
  const filename = join(directory, 'drama.sqlite');
  try {
    const first = await fixture(t, filename);
    const p = await first.project();
    const season = await saved(await first.post(`/projects/${p.id}/seasons`, { name: '续篇' }));
    const episode = await saved(await first.post(`/projects/${p.id}/episodes`, { name: '续篇开场', seasonId: season.id }));
    await saved(await first.post(`/projects/${p.id}/seasons/${season.id}/move`, { direction: 'up' }), 200);
    await first.close();
    const second = await fixture(t, filename);
    assert.equal(second.database.prepare('SELECT count(*) AS count FROM seasons WHERE project_id = ?').get(p.id).count, 2);
    assert.equal(second.database.prepare('SELECT id FROM seasons WHERE project_id = ? ORDER BY position LIMIT 1').get(p.id).id, season.id);
    assert.equal(second.database.prepare('SELECT season_id FROM episodes WHERE id = ?').get(episode.id).season_id, season.id);
    assert.match(await (await second.get(`/projects/${p.id}?view=episode&episode=${episode.id}`)).text(), /续篇开场/);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
