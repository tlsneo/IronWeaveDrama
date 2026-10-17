import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';
import { readEpisodeStoryboards } from '../src/storyboards.js';

const tables = ['projects', 'seasons', 'episodes', 'characters', 'api_configs', 'character_boards', 'character_references', 'episode_scripts', 'scenes', 'episode_extractions', 'episode_occurrences', 'scene_images', 'scene_references'];
const snapshot = db => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const schema = db => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
const sequences = db => db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
const resources = JSON.stringify({ revision: 'fixture-resource-hash', characters: [], scenes: [] });
const shots = JSON.stringify([{ title: '旧镜头', duration: 3.2, quote: '旧依据' }]);
const insertPlan = (db, episode = 20) => db.prepare('INSERT INTO episode_storyboards (episode_id, script_revision, revision, max_shot_seconds, reviewed, resources_json, shots) VALUES (?, 2, 3, 5, 1, ?, ?)').run(episode, resources, shots);

test('真实14→15迁移失败回滚完整schema／资料／序列，重试和重启保留分镜及旧记录，集／季／项目删除级联', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-storyboards-migration-'));
  const filename = join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    db.exec(`DROP TABLE look_images;
      DROP TABLE look_assets;
      DROP TABLE looks;
      DROP TABLE production_asset_images;
      DROP TABLE production_assets;
      DROP TABLE episode_storyboards; PRAGMA user_version = 14;
      INSERT INTO projects VALUES (7, '旧项目', '水墨', '16:9'), (8, '其他项目', '电影', '9:16');
      INSERT INTO seasons VALUES (12, 7, '旧季', 1), (13, 7, '另一季', 2), (14, 8, '外部季', 1);
      INSERT INTO episodes VALUES (20, 12, '旧集', 1), (21, 12, '同季集', 2), (22, 13, '另一季集', 1), (30, 14, '外部集', 1);
      INSERT INTO characters (id, project_id, name, age, appearance_notes) VALUES (40, 7, '旧角色', 28, '旧外观');
      INSERT INTO scenes VALUES (50, 7, '旧场景', '旧布局');
      INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (60, '旧接口', 'llm', 'http://127.0.0.1:1/v1', 'synthetic-migration-token', 'dummy-model');
      INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (20, '旧小说', '旧剧本', '旧说明', 2);
      INSERT INTO episode_extractions (episode_id, script_revision, revision, candidates) VALUES (20, 2, 3, '[{"kind":"scene","name":"旧候选"}]');
      INSERT INTO episode_occurrences (id, episode_id, kind, character_id, scene_id, source_name, scene_heading, quote, source_start, mode, details, script_revision, revision, ignored, needs_review) VALUES
        (70, 20, 'character', 40, NULL, '旧角色', '1-1 房间 内 日', '旧人物依据', 0, 'memory', '旧人物说明', 2, 3, 0, 1),
        (71, 20, 'scene', NULL, 50, '旧场景', '1-1 房间 内 日', '旧场景依据', 4, 'on_screen', '旧场景说明', 2, 4, 1, 0);`);
    const bytes = Buffer.from('dummy-migration-image');
    db.prepare("INSERT INTO character_references (id, character_id, image, mime, width, height) VALUES (80, 40, ?, 'image/png', 16, 9)").run(bytes);
    db.prepare("INSERT INTO character_boards (id, character_id, image, mime, width, height, valid, revision, model, prompt, reference_id, cleared) VALUES (81, 40, ?, 'image/png', 16, 9, 1, 'old-character-revision', 'dummy-model', 'old-character-prompt', 80, 0)").run(bytes);
    db.prepare("INSERT INTO scene_references (id, scene_id, image, mime, width, height) VALUES (90, 50, ?, 'image/png', 16, 9)").run(bytes);
    db.prepare("INSERT INTO scene_images (id, scene_id, image, mime, width, height, valid, revision, model, prompt, reference_id, cleared) VALUES (91, 50, ?, 'image/png', 16, 9, 1, 'old-scene-revision', 'dummy-model', 'old-scene-prompt', 90, 0)").run(bytes);
    const original = snapshot(db), originalSchema = schema(db), originalSequences = sequences(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    db.close(); db = undefined;
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 15')) throw new Error('simulated storyboard migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /simulated storyboard migration failure/); t.mock.restoreAll();
    db = new DatabaseSync(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'episode_storyboards'").get(), undefined);
    assert.deepEqual(snapshot(db), original); assert.deepEqual(schema(db), originalSchema); assert.deepEqual(sequences(db), originalSequences);
    db.close(); db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 18);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(snapshot(db), original); assert.deepEqual(sequences(db), originalSequences);
    assert.deepEqual(db.prepare('SELECT * FROM episode_storyboards').all(), []);
    for (const episode of [20, 21, 22, 30]) insertPlan(db, episode);
    const plans = db.prepare('SELECT * FROM episode_storyboards ORDER BY episode_id').all();
    db.close(); db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 18);
    assert.deepEqual(snapshot(db), original); assert.deepEqual(db.prepare('SELECT * FROM episode_storyboards ORDER BY episode_id').all(), plans);
    assert.deepEqual(readEpisodeStoryboards(db, 20), { revision: 3, scriptRevision: 2, resourceRevision: 'fixture-resource-hash', maxShotSeconds: 5, reviewed: true, shots: JSON.parse(shots) });
    db.exec('DELETE FROM api_configs WHERE id = 60'); assert.deepEqual(db.prepare('SELECT * FROM episode_storyboards ORDER BY episode_id').all(), plans);
    db.exec('DELETE FROM episodes WHERE id = 20');
    assert.equal(db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 20').get(), undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM episode_storyboards').get().n, 3);
    db.exec('DELETE FROM seasons WHERE id = 12');
    assert.deepEqual(db.prepare('SELECT episode_id FROM episode_storyboards ORDER BY episode_id').all().map(row => row.episode_id), [22, 30]);
    db.exec('DELETE FROM projects WHERE id = 7');
    assert.deepEqual(db.prepare('SELECT episode_id FROM episode_storyboards').all().map(row => row.episode_id), [30]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close(); db = openDatabase(filename); assert.equal(readEpisodeStoryboards(db, 30).revision, 3);
  } finally { t.mock.restoreAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema15分镜主键／外键及整数范围约束：允许scriptRevision0，计划revision>0，单镜1–15，核对状态0／1', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec("INSERT INTO projects VALUES (7, '约束测试', '水墨', '16:9'); INSERT INTO seasons VALUES (12, 7, '测试季', 1); INSERT INTO episodes VALUES (20, 12, '测试集', 1)");
    insertPlan(db);
    assert.throws(() => insertPlan(db), /UNIQUE/); assert.throws(() => insertPlan(db, 999), /FOREIGN KEY/);
    db.exec('UPDATE episode_storyboards SET script_revision = 0, max_shot_seconds = 1, reviewed = 0');
    db.exec('UPDATE episode_storyboards SET max_shot_seconds = 15, reviewed = 1');
    for (const [field, values] of Object.entries({ script_revision: [-1, 1.5, 'bad'], revision: [0, -1, 1.5, 'bad'], max_shot_seconds: [0, 16, 1.5, 'bad'], reviewed: [-1, 2, 0.5, 'bad'] })) {
      for (const value of values) assert.throws(() => db.prepare(`UPDATE episode_storyboards SET ${field} = ?`).run(value), /CHECK|datatype/, `${field}=${value}`);
    }
    for (const field of ['script_revision', 'revision', 'max_shot_seconds', 'reviewed', 'resources_json', 'shots']) assert.throws(() => db.exec(`UPDATE episode_storyboards SET ${field} = NULL`), /NOT NULL/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
