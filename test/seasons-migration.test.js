import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

const versionOne = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    style TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('9:16', '16:9', '21:9', '4:3', '3:4', '1:1'))
  );
  INSERT INTO projects VALUES (12, '已有的短剧', '写实电影', '21:9');
  PRAGMA user_version = 1;
`;

test('版本 1 升级为已有项目补第一季，重复启动不会重复补季，项目资料不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-seasons-upgrade-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = new DatabaseSync(filename);
    database.exec(versionOne);
    const original = database.prepare('SELECT * FROM projects').get();
    database.close();
    database = openDatabase(filename);
    assert.deepEqual(database.prepare('SELECT * FROM projects').get(), original);
    const season = database.prepare('SELECT * FROM seasons').get();
    assert.equal(season.name, '第一季');
    assert.equal(season.project_id, 12);
    assert.equal(season.position, 1);
    assert.throws(() => database.prepare('INSERT INTO episodes (season_id, name, position) VALUES (?, ?, ?)').run(99999, '无所属季', 1), /FOREIGN KEY constraint failed/);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('SELECT count(*) AS count FROM seasons').get().count, 1);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 15);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('分季迁移中途失败时回滚新增表，保留原项目、原版本和已有数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-seasons-rollback-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = new DatabaseSync(filename);
    database.exec(`${versionOne} CREATE TABLE episodes (name TEXT); INSERT INTO episodes VALUES ('原有数据');`);
    const original = database.prepare('SELECT * FROM projects').get();
    database.close();
    assert.throws(() => openDatabase(filename), /already exists/);
    database = new DatabaseSync(filename);
    assert.deepEqual(database.prepare('SELECT * FROM projects').get(), original);
    assert.equal(database.prepare('SELECT name FROM episodes').get().name, '原有数据');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'seasons'").get(), undefined);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
