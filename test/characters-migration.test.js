import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

function versionTwo(filename) {
  const database = openDatabase(filename);
  database.exec(`
    DROP TABLE character_boards;
    DROP TABLE characters;
    DROP TABLE api_configs;
    PRAGMA user_version = 2;
    INSERT INTO projects VALUES (7, '已有短剧', '写实电影', '9:16');
    INSERT INTO seasons VALUES (12, 7, '已有季', 1);
    INSERT INTO episodes VALUES (20, 12, '已有集', 1);
  `);
  return database;
}

function originals(database) {
  return ['projects', 'seasons', 'episodes'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

test('版本 2 升级只新增角色表，保留项目、季和集；重启保留角色并启用归属与年龄约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-characters-upgrade-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = versionTwo(filename);
    const before = originals(database);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
    assert.deepEqual(originals(database), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM characters').get().count, 0);
    database.prepare('INSERT INTO characters (project_id, name, age) VALUES (?, ?, ?)').run(7, '原角色', 25);
    assert.throws(() => database.prepare('INSERT INTO characters (project_id, name) VALUES (?, ?)').run(9999, '越界'), /FOREIGN KEY/);
    assert.throws(() => database.prepare('UPDATE characters SET age = -1').run(), /CHECK/);
    assert.throws(() => database.prepare('UPDATE characters SET age = 1.5').run(), /CHECK/);
    database.close();
    database = openDatabase(filename);
    assert.deepEqual(originals(database), before);
    assert.equal(database.prepare('SELECT count(*) AS count FROM characters').get().count, 1);
    assert.equal(database.prepare('SELECT name FROM characters').get().name, '原角色');
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('角色迁移中途失败，新增表回滚，原版本及项目、季、集完整保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-characters-rollback-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = versionTwo(filename);
    database.exec('CREATE INDEX characters_project ON seasons (name)');
    const before = originals(database);
    database.close();
    assert.throws(() => openDatabase(filename), /already exists/);
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(originals(database), before);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'characters'").get(), undefined);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
