import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

const legacySchema = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    style TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('9:16', '16:9', '1:1'))
  );
  INSERT INTO projects VALUES (7, '原有短剧', '写实电影', '9:16');
`;

test('旧数据库升级后保留所有项目字段与 ID，允许新比例，重复打开不会丢失数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-migration-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = new DatabaseSync(filename);
    database.exec(legacySchema);
    const original = database.prepare('SELECT * FROM projects').get();
    database.close();
    database = openDatabase(filename);
    assert.deepEqual(database.prepare('SELECT * FROM projects WHERE id = 7').get(), original);
    const insert = database.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)');
    for (const ratio of ['21:9', '4:3', '3:4']) insert.run('新短剧', '国风水墨', ratio);
    assert.throws(() => insert.run('无效比例', '国风水墨', '5:7'), /CHECK constraint failed/);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('SELECT count(*) AS count FROM projects').get().count, 4);
    assert.deepEqual(database.prepare('SELECT * FROM projects WHERE id = 7').get(), original);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 12);
    const season = database.prepare('SELECT name, project_id FROM seasons WHERE project_id = 7').get();
    assert.equal(season.name, '第一季');
    assert.equal(season.project_id, 7);
    assert.equal(database.prepare('SELECT count(*) AS count FROM seasons WHERE project_id = 7').get().count, 1);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('升级失败时回滚原表和数据，不留下半完成的迁移', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-migration-failure-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = new DatabaseSync(filename);
    database.exec(legacySchema);
    database.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO projects VALUES (8, '异常旧数据', '写实电影', '5:7');");
    const original = database.prepare('SELECT * FROM projects ORDER BY id').all();
    database.close();
    assert.throws(() => openDatabase(filename), /CHECK constraint failed/);
    database = new DatabaseSync(filename);
    assert.deepEqual(database.prepare('SELECT * FROM projects ORDER BY id').all(), original);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'projects_previous'").get(), undefined);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
