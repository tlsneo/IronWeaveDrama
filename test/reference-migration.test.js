import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

test('版本 9 升级保留原项目、角色板及配置，新增空参考图关系；失败整组回滚，重复打开不丢资料', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-reference-migration-'));
  const filename = join(directory, 'drama.sqlite');
  let database;
  const tables = ['projects', 'characters', 'character_boards', 'api_configs'];
  const snapshot = db => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  try {
    database = openDatabase(filename);
    database.exec(`
      DROP TABLE episode_occurrences;
      DROP TABLE episode_extractions;
      DROP TABLE scenes;
      DROP TABLE episode_scripts;
      ALTER TABLE character_boards DROP COLUMN reference_id;
      DROP TABLE character_references;
      PRAGMA user_version = 9;
      INSERT INTO projects VALUES (1, '已有项目', '写实', '9:16');
      INSERT INTO characters (id, project_id, name, age) VALUES (1, 1, '已有角色', 28);
      INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('已有配置', 'text_to_image', 'https://example.test/v1', 'saved-secret', 'saved-model');
    `);
    database.prepare("INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (1, ?, 'image/png', 16, 9, 1, 'revision', 'saved-model', 'saved-prompt')").run(Buffer.from('old-image'));
    const original = snapshot(database);
    database.close();
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 10')) throw new Error('reference migration failure'); return result; });
    assert.throws(() => openDatabase(filename), /reference migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 9);
    assert.deepEqual(snapshot(database), original);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'character_references'").get(), undefined);
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 12);
    original[2] = original[2].map(row => Object.assign(Object.create(null), row, { reference_id: null }));
    assert.deepEqual(snapshot(database), original);
    assert.equal(database.prepare('SELECT count(*) AS n FROM character_references').get().n, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    database.close(); database = openDatabase(filename);
    assert.deepEqual(snapshot(database), original);
  } finally { t.mock.restoreAll(); database?.close(); await rm(directory, { recursive: true, force: true }); }
});
