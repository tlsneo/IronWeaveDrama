import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

async function fixture(t, filename = ':memory:') {
  const database = openDatabase(filename);
  database.exec(`
    INSERT INTO projects VALUES (1, '短剧 A', '写实', '9:16'), (2, '短剧 B', '水墨', '16:9');
    INSERT INTO seasons VALUES (1, 1, '第一季 A', 1), (2, 2, '第一季 B', 1), (3, 1, '第二季 A', 2);
    INSERT INTO episodes VALUES (1, 1, '第一集 A', 1), (2, 2, '第一集 B', 1), (3, 3, '第二季第一集', 1);
    INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '角色 A', 28), (2, 2, '角色 B', 28);
    INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, 'API A', 'text_to_image', 'https://example.test/v1', 'secret', 'image-model');
  `);
  for (const id of [1, 2]) database.prepare('INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (?, ?, ?, 16, 9, 1, ?, ?, ?)').run(id, Buffer.from('saved-image'), 'image/png', 'revision', 'image-model', 'saved-prompt');
  const server = createApp(database);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  t.after(close);
  const post = (path, name, options = {}) => fetch(url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }), ...options });
  return { database, url, close, post };
}
const snapshot = database => ['projects', 'seasons', 'episodes', 'characters', 'character_boards', 'api_configs'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

test('短剧、角色、季集、剧本入口及 API 卡片提供独立删除按钮，详情可删除角色和集，按钮不嵌在链接中', async t => {
  const f = await fixture(t);
  for (const [path, target] of [
    ['/', '/projects/1/delete'],
    ['/projects/1?resource=characters', '/projects/1/characters/1/delete'],
    ['/projects/1?resource=characters&character=1', '/projects/1/characters/1/delete'],
    ['/projects/1?view=seasons', '/projects/1/seasons/1/delete'],
    ['/projects/1?view=seasons', '/projects/1/episodes/1/delete'],
    ['/projects/1?view=scripts', '/projects/1/episodes/1/delete'],
    ['/projects/1?view=episode&episode=1', '/projects/1/episodes/1/delete'],
    ['/settings', '/settings/api/1/delete'],
  ]) {
    const response = await fetch(f.url + path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`data-delete-url="${target}"`));
    assert.match(html, /id="delete-error"[^>]*role="alert"/);
    assert.match(html, /src="\/delete.js"/);
    for (const [, content] of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)) assert.ok(!content.includes('data-delete-url'));
  }
  assert.equal((await fetch(f.url + '/delete.js')).status, 200);
});

test('删除短剧级联删除其季、集、角色、图片及提示词，其他项目与全局 API 不变', async t => {
  const f = await fixture(t);
  const original = snapshot(f.database);
  const response = await f.post('/projects/1/delete', '短剧 A');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).redirect, '/');
  const after = snapshot(f.database);
  assert.deepEqual(after[0], original[0].filter(row => row.id === 2));
  assert.deepEqual(after[1], original[1].filter(row => row.project_id === 2));
  assert.deepEqual(after[2], original[2].filter(row => row.season_id === 2));
  assert.deepEqual(after[3], original[3].filter(row => row.project_id === 2));
  assert.deepEqual(after[4], original[4].filter(row => row.character_id === 2));
  assert.deepEqual(after[5], original[5]);
  assert.equal((await fetch(f.url + '/projects/1')).status, 404);
  assert.equal((await f.post('/projects/1/delete', '短剧 A')).status, 404);
});

test('删除角色清掉包括已清空在内的历史图片；删除 API 不影响现有角色或图片', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE character_boards SET cleared = 1 WHERE character_id = 1');
  const response = await f.post('/projects/1/characters/1/delete', '角色 A');
  assert.equal(response.status, 200);
  assert.match((await response.json()).redirect, /resource=characters/);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM character_boards WHERE character_id = 1').get().count, 0);
  assert.equal(f.database.prepare('SELECT name FROM characters WHERE id = 2').get().name, '角色 B');
  const original = snapshot(f.database);
  const api = await f.post('/settings/api/1/delete', 'API A');
  assert.equal(api.status, 200);
  const after = snapshot(f.database);
  assert.deepEqual(after.slice(0, 5), original.slice(0, 5));
  assert.equal(after[5].length, 0);
});

test('删除集仅移除本集，删除季仅移除本季及其集；删除最后一季后提供空状态并仍可创建', async t => {
  const f = await fixture(t);
  let response = await f.post('/projects/1/episodes/1/delete', '第一集 A');
  assert.equal(response.status, 200);
  assert.match((await response.json()).redirect, /view=seasons&season=1/);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM episodes').get().count, 2);
  response = await f.post('/projects/1/seasons/3/delete', '第二季 A');
  assert.equal(response.status, 200);
  assert.equal(f.database.prepare('SELECT id FROM episodes WHERE id = 3').get(), undefined);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM characters').get().count, 2);
  assert.equal((await f.post('/projects/1/seasons/1/delete', '第一季 A')).status, 200);
  assert.match(await (await fetch(f.url + '/projects/1?view=seasons')).text(), /还没有季/);
  assert.match(await (await fetch(f.url + '/projects/1?view=scripts')).text(), /去分季／分集管理添加/);
  response = await fetch(f.url + '/projects/1/seasons', { method: 'POST', body: new URLSearchParams({ name: '新季' }) });
  assert.equal(response.status, 201);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM seasons WHERE project_id = 2').get().count, 1);
});

test('删除验证归属、确认、名称快照和 ID；跨站、非法格式、过大请求及 GET 不能删除', async t => {
  const f = await fixture(t);
  const before = snapshot(f.database);
  for (const [path, name] of [['/projects/1/delete', '短剧 A'], ['/projects/1/characters/1/delete', '角色 A'], ['/projects/1/seasons/1/delete', '第一季 A'], ['/projects/1/episodes/1/delete', '第一集 A'], ['/settings/api/1/delete', 'API A']]) {
    assert.equal((await f.post(path, name, { body: new URLSearchParams({ name }) })).status, 400);
    assert.equal((await f.post(path, name, { body: new URLSearchParams({ confirmed: 'no', name }) })).status, 400);
    assert.equal((await f.post(path, name, { body: new URLSearchParams([['confirmed', 'yes'], ['name', name], ['name', name]]) })).status, 400);
    assert.equal((await f.post(path, '已改名')).status, 409);
    assert.equal((await f.post(path, name, { headers: { Origin: 'https://other.test' } })).status, 403);
    assert.equal((await f.post(path, name, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.post(path, name, { headers: { 'Content-Type': 'application/json' } })).status, 415);
    assert.equal((await f.post(path, 'x'.repeat(9000))).status, 413);
    assert.equal((await fetch(f.url + path)).status, 404);
    const unsupported = await fetch(f.url + path, { method: 'DELETE' });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('allow'), 'POST');
    assert.equal((await f.post(path.replace('/1/delete', '/9007199254740992/delete'), name)).status, 404);
  }
  for (const path of ['/projects/2/characters/1/delete', '/projects/2/seasons/1/delete', '/projects/2/episodes/1/delete', '/projects/999999/delete']) assert.equal((await f.post(path, '越界')).status, 404);
  assert.deepEqual(snapshot(f.database), before);
});

test('特殊名称安全显示在删除按钮属性，不触发 HTML；级联删除失败整组回滚', async t => {
  const f = await fixture(t);
  const name = '<script>alert(1)</script> "&';
  f.database.prepare('UPDATE projects SET name = ? WHERE id = 1').run(name);
  const html = await (await fetch(f.url)).text();
  assert.match(html, /data-delete-name="&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;&amp;"/);
  assert.doesNotMatch(html, /<script>alert/);
  const original = snapshot(f.database);
  f.database.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON character_boards BEGIN SELECT RAISE(ABORT, 'simulated deletion failure'); END;");
  assert.equal((await f.post('/projects/1/delete', name)).status, 500);
  assert.deepEqual(snapshot(f.database), original);
});

test('删除状态重启后保持，六类 ID 删除后不复用，旧卡片不能误删新记录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-delete-persist-'));
  try {
    const filename = join(directory, 'drama.sqlite');
    const f = await fixture(t, filename);
    assert.equal((await f.post('/projects/2/delete', '短剧 B')).status, 200);
    assert.equal((await f.post('/settings/api/1/delete', 'API A')).status, 200);
    await f.close();
    const database = openDatabase(filename);
    try {
      assert.equal(database.prepare('SELECT id FROM projects WHERE id = 2').get(), undefined);
      const projectId = Number(database.prepare("INSERT INTO projects (name, style, aspect_ratio) VALUES ('短剧 B', '写实', '9:16')").run().lastInsertRowid);
      assert.ok(projectId > 2);
      const seasonId = Number(database.prepare("INSERT INTO seasons (project_id, name, position) VALUES (?, '新季', 1)").run(projectId).lastInsertRowid);
      assert.ok(seasonId > 3);
      const episodeId = Number(database.prepare("INSERT INTO episodes (season_id, name, position) VALUES (?, '新集', 1)").run(seasonId).lastInsertRowid);
      assert.ok(episodeId > 3);
      const characterId = Number(database.prepare("INSERT INTO characters (project_id, name) VALUES (?, '角色 B')").run(projectId).lastInsertRowid);
      assert.ok(characterId > 2);
      const boardId = Number(database.prepare('INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (?, ?, ?, 16, 9, 1, ?, ?, ?)').run(characterId, Buffer.from('new'), 'image/png', 'new', 'new', 'new').lastInsertRowid);
      assert.ok(boardId > 2);
      const apiId = Number(database.prepare("INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('API A', 'llm', 'https://example.test', 'secret', 'model')").run().lastInsertRowid);
      assert.ok(apiId > 1);
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('版本 8 升级保留完整图片、配置和归属，启用不复用 ID；重建失败回滚原表与数据', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-delete-migration-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    const f = await fixture(t, filename);
    f.database.exec('DROP TABLE episode_scripts; ALTER TABLE character_boards DROP COLUMN reference_id; DROP TABLE character_references;');
    const original = snapshot(f.database);
    await f.close();
    // 用当前表结构重建一个真正没有 AUTOINCREMENT 的版本 8。
    database = new DatabaseSync(filename);
    database.exec('PRAGMA foreign_keys = OFF; BEGIN');
    for (const table of ['projects', 'seasons', 'episodes', 'characters', 'api_configs', 'character_boards']) {
      const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
      const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
      database.exec(sql.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/i, `CREATE TABLE ${table}_old`).replace(' AUTOINCREMENT', ''));
      database.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table};`);
      for (const index of indexes) database.exec(index.sql);
    }
    database.exec('PRAGMA user_version = 8; COMMIT'); database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 9')) throw new Error('simulated id migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /simulated id migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 8);
    assert.deepEqual(snapshot(database), original);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_new'").get(), undefined);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    original[4] = original[4].map(row => Object.assign(Object.create(null), row, { reference_id: null }));
    assert.deepEqual(snapshot(database), original);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => database.prepare("INSERT INTO characters (project_id, name) VALUES (999999, '越界')").run(), /FOREIGN KEY/);
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});
