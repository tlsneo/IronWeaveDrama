import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

function versionThree(filename) {
  const database = openDatabase(filename);
  database.exec(`
    DROP TABLE episode_occurrences;
    DROP TABLE episode_extractions;
    DROP TABLE scenes;
    DROP TABLE episode_scripts;
    DROP TABLE character_boards;
    DROP TABLE character_references;
    DROP TABLE api_configs;
    PRAGMA user_version = 3;
    INSERT INTO projects VALUES (7, '原项目', '写实电影', '9:16');
    INSERT INTO seasons VALUES (12, 7, '原季', 1);
    INSERT INTO episodes VALUES (20, 12, '原集', 1);
    INSERT INTO characters (id, project_id, name, age) VALUES (30, 7, '原角色', 28);
  `);
  return database;
}

function versionFour(database) {
  database.exec(`
    CREATE TABLE image_api_settings (id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT NOT NULL, size TEXT NOT NULL);
    INSERT INTO image_api_settings VALUES (1, 'http://127.0.0.1:3001/v1', 'existing-key', 'existing-model', '1920x1080');
    PRAGMA user_version = 4;
  `);
}

function versionFive(database) {
  database.exec(`
    CREATE TABLE api_configs (type TEXT PRIMARY KEY NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT NOT NULL, size TEXT);
    INSERT INTO api_configs VALUES ('text_to_image', 'http://127.0.0.1:3001/v1', 'image-key', 'image-model', '1920x1080');
    INSERT INTO api_configs VALUES ('llm', 'http://127.0.0.1:3002/v1', 'language-key', 'language-model', NULL);
    PRAGMA user_version = 5;
  `);
}

const originals = database => ['projects', 'seasons', 'episodes', 'characters'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

for (const version of [3, 4]) {
  test(`版本 ${version} 升级保留项目和角色${version === 4 ? '，原图片配置迁入文生图类型，保留密钥和旧尺寸' : '，新增四类 API 存储'}，重启不重复迁移`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironweave-settings-upgrade-'));
    const filename = join(directory, 'drama.sqlite');
    let database;
    try {
      database = versionThree(filename);
      if (version === 4) versionFour(database);
      const before = originals(database);
      database.close();
      database = openDatabase(filename);
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual(originals(database), before);
      assert.equal(database.prepare('SELECT count(*) AS count FROM api_configs').get().count, version === 4 ? 1 : 0);
      if (version === 4) {
        const config = database.prepare('SELECT * FROM api_configs').get();
        assert.equal(config.type, 'text_to_image');
        assert.equal(config.api_key, 'existing-key');
        assert.equal(config.model, 'existing-model');
        assert.equal(config.size, '1920x1080');
      }
      database.close();
      database = openDatabase(filename);
      assert.deepEqual(originals(database), before);
      assert.equal(database.prepare('SELECT count(*) AS count FROM api_configs').get().count, version === 4 ? 1 : 0);
    } finally {
      database?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('API 迁移中途失败，版本、角色资料和原图片配置均回滚保留', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-settings-rollback-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = versionThree(filename);
    versionFour(database);
    const before = originals(database);
    const oldConfig = database.prepare('SELECT * FROM image_api_settings').get();
    database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 5')) throw new Error('simulated migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /simulated migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(originals(database), before);
    assert.deepEqual(database.prepare('SELECT * FROM image_api_settings').get(), oldConfig);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'api_configs'").get(), undefined);
  } finally {
    t.mock.restoreAll();
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('版本 5 的类型配置迁成具名卡片，保留地址、密钥、模型和旧尺寸，并允许同类型新增', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-api-cards-upgrade-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = versionThree(filename);
    versionFive(database);
    const before = originals(database);
    const configs = database.prepare('SELECT type, base_url, api_key, model, size FROM api_configs ORDER BY type').all();
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 13);
    assert.deepEqual(originals(database), before);
    assert.deepEqual(database.prepare('SELECT type, base_url, api_key, model, size FROM api_configs ORDER BY type').all(), configs);
    const rows = database.prepare('SELECT id, name FROM api_configs ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.id > 0 && row.name));
    database.prepare('INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES (?, ?, ?, ?, ?)').run('第二个语言模型', 'llm', 'http://localhost:3003/v1', 'another-key', 'another-model');
    assert.equal(database.prepare("SELECT count(*) AS count FROM api_configs WHERE type = 'llm'").get().count, 2);
    database.close();
    database = openDatabase(filename);
    assert.deepEqual(database.prepare('SELECT id, name FROM api_configs ORDER BY id LIMIT 2').all(), rows);
    assert.equal(database.prepare('SELECT count(*) AS count FROM api_configs').get().count, 3);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('卡片迁移中途失败回滚表结构及密钥，不留下临时表或半完成的新卡片', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-api-cards-rollback-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  try {
    database = versionThree(filename);
    versionFive(database);
    const configs = database.prepare('SELECT * FROM api_configs ORDER BY type').all();
    const before = originals(database);
    database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 6')) throw new Error('simulated card migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /simulated card migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual(originals(database), before);
    assert.deepEqual(database.prepare('SELECT * FROM api_configs ORDER BY type').all(), configs);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'api_configs_previous'").get(), undefined);
  } finally {
    t.mock.restoreAll();
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
