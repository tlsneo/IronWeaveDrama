import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

test('版本 13 场景图片迁移失败完整回滚，升级 14 保留旧资料，重启保留图片及不复用 ID，删除级联正确', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-scene-images-migration-'));
  const filename = join(directory, 'drama.sqlite');
  const tables = ['projects', 'seasons', 'episodes', 'characters', 'api_configs', 'character_boards', 'character_references', 'episode_scripts', 'scenes', 'episode_extractions', 'episode_occurrences'];
  const snapshot = db => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const imageSnapshot = db => ['scene_images', 'scene_references'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const schema = db => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
  const bytes = Buffer.from('migration-test-image');
  let database;
  try {
    database = openDatabase(filename);
    database.exec(`
      DROP TABLE episode_storyboards;
      DROP TABLE scene_images;
      DROP TABLE scene_references;
      PRAGMA user_version = 13;
      INSERT INTO projects VALUES (7, '旧项目', '水墨', '16:9');
      INSERT INTO seasons VALUES (12, 7, '旧季', 1);
      INSERT INTO episodes VALUES (20, 12, '旧集', 1);
      INSERT INTO characters (id, project_id, name, age) VALUES (30, 7, '旧角色', 28);
      INSERT INTO scenes (id, project_id, name, description) VALUES (40, 7, '旧场景', '旧布局'), (41, 7, '另一场景', '保留布局');
      INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('旧接口', 'text_to_image', 'https://example.test/v1', 'saved-key', 'saved-model');
      INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (20, '旧原文', '旧剧本', '旧说明', 2);
      INSERT INTO episode_extractions (episode_id, script_revision, revision, candidates) VALUES (20, 2, 3, '[{"kind":"scene","name":"候选场景"}]');
      INSERT INTO episode_occurrences (id, episode_id, kind, character_id, scene_id, source_name, scene_heading, quote, source_start, mode, details, script_revision, revision, ignored, needs_review) VALUES
        (50, 20, 'character', 30, NULL, '旧角色', '室内，白天', '角色出场', 0, 'on_screen', '旧人物备注', 2, 3, 0, 1),
        (51, 20, 'scene', NULL, 40, '旧场景', '室内，白天', '场景出场', 4, 'on_screen', '旧场景备注', 2, 4, 1, 0);
    `);
    database.prepare("INSERT INTO character_references (id, character_id, image, mime, width, height) VALUES (60, 30, ?, 'image/png', 16, 9)").run(bytes);
    database.prepare("INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt, reference_id) VALUES (30, ?, 'image/png', 16, 9, 1, 'old-revision', 'old-model', 'old-prompt', 60)").run(bytes);
    const original = snapshot(database);
    const originalSchema = schema(database);
    const originalSequences = database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
    database.close(); database = undefined;

    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 14')) throw new Error('scene image migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /scene image migration failure/);
    t.mock.restoreAll();
    database = new DatabaseSync(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 13);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('scene_images', 'scene_references')").all(), []);
    assert.deepEqual(snapshot(database), original);
    assert.deepEqual(schema(database), originalSchema);
    assert.deepEqual(database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(), originalSequences);
    database.close(); database = undefined;

    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 15);
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(snapshot(database), original);
    assert.deepEqual(imageSnapshot(database), [[], []]);
    const insertReference = sceneId => Number(database.prepare("INSERT INTO scene_references (scene_id, image, mime, width, height) VALUES (?, ?, 'image/png', 16, 9)").run(sceneId, bytes).lastInsertRowid);
    const insertImage = (sceneId, referenceId, valid = 1, cleared = 0) => Number(database.prepare("INSERT INTO scene_images (scene_id, image, mime, width, height, valid, revision, model, prompt, reference_id, cleared) VALUES (?, ?, 'image/png', 16, 9, ?, 'scene-revision', 'scene-model', 'scene-prompt', ?, ?)").run(sceneId, bytes, valid, referenceId, cleared).lastInsertRowid);
    const referenceId = insertReference(40);
    const imageId = insertImage(40, referenceId);
    insertImage(40, referenceId, 0, 1);
    const lastReferenceId = insertReference(41);
    const lastImageId = insertImage(41, lastReferenceId);
    assert.throws(() => insertReference(9999), /FOREIGN KEY/);
    assert.throws(() => insertImage(9999, referenceId), /FOREIGN KEY/);
    assert.throws(() => insertImage(40, 9999), /FOREIGN KEY/);
    const savedImages = imageSnapshot(database);
    database.close(); database = undefined;

    database = openDatabase(filename);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 15);
    assert.deepEqual(snapshot(database), original);
    assert.deepEqual(imageSnapshot(database), savedImages);
    database.prepare('DELETE FROM scene_references WHERE id = ?').run(referenceId);
    assert.equal(database.prepare('SELECT reference_id FROM scene_images WHERE id = ?').get(imageId).reference_id, null);
    assert.ok(database.prepare('SELECT reference_id FROM scene_images WHERE scene_id = 40').all().every(row => row.reference_id === null));
    assert.equal(database.prepare('SELECT count(*) AS n FROM scene_images WHERE scene_id = 40').get().n, 2);
    database.prepare('DELETE FROM scene_images WHERE id = ?').run(lastImageId);
    database.prepare('DELETE FROM scene_references WHERE id = ?').run(lastReferenceId);
    const afterDeletes = imageSnapshot(database);
    database.close(); database = undefined;

    database = openDatabase(filename);
    assert.deepEqual(snapshot(database), original);
    assert.deepEqual(imageSnapshot(database), afterDeletes);
    const nextReferenceId = insertReference(41);
    const nextImageId = insertImage(41, nextReferenceId);
    assert.ok(nextReferenceId > lastReferenceId);
    assert.ok(nextImageId > lastImageId);
    database.exec('DELETE FROM scenes WHERE id = 41');
    assert.equal(database.prepare('SELECT count(*) AS n FROM scene_images WHERE scene_id = 41').get().n, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM scene_references WHERE scene_id = 41').get().n, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM scene_images WHERE scene_id = 40').get().n, 2);
    insertReference(40);
    database.exec('DELETE FROM projects WHERE id = 7');
    assert.deepEqual(imageSnapshot(database), [[], []]);
    assert.deepEqual(snapshot(database), original.map((rows, index) => tables[index] === 'api_configs' ? rows : []));
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    t.mock.restoreAll();
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
