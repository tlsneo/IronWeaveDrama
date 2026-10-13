import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.js';

const oldTables = ['projects', 'seasons', 'episodes', 'characters', 'api_configs', 'character_boards', 'character_references', 'episode_scripts', 'scenes', 'episode_extractions', 'episode_occurrences', 'scene_images', 'scene_references', 'episode_storyboards'];
const newTables = ['production_assets', 'production_asset_images', 'looks', 'look_assets', 'look_images'];
const snapshot = (db, tables) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const schema = db => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
const sequences = db => db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
const bytes = Buffer.from('synthetic-migration-image');
const inputs = JSON.stringify({ character: { id: 40 }, assets: [{ id: 101 }] });
const asset = (db, project = 7) => Number(db.prepare("INSERT INTO production_assets (project_id, kind, name) VALUES (?, 'props', '旧道具')").run(project).lastInsertRowid);
const assetImage = (db, id) => Number(db.prepare("INSERT INTO production_asset_images (asset_id, image, mime, width, height) VALUES (?, ?, 'image/png', 16, 9)").run(id, bytes).lastInsertRowid);
const look = (db, project = 7, actor = 40) => Number(db.prepare("INSERT INTO looks (project_id, character_id, name, prompt) VALUES (?, ?, '旧定妆', '  原样提示词\n')").run(project, actor).lastInsertRowid);
const lookImage = (db, id, valid = 1, cleared = 0) => Number(db.prepare("INSERT INTO look_images (look_id, image, mime, width, height, valid, cleared, revision, model, prompt, inputs_json) VALUES (?, ?, 'image/png', 16, 9, ?, ?, 'fixture-input-hash', 'fixture-model', 'fixture-prompt', ?)").run(id, bytes, valid, cleared, inputs).lastInsertRowid);

// Only temporary SQLite files and synthetic data are used; never open the user's data directory.
test('15→16失败回滚完整schema／序列／旧资料，重试与重开保留演员参考图、剧本、出场及当前分镜', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-looks-migration-'));
  const filename = join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    db.exec(`DROP TABLE look_images;
      DROP TABLE look_assets;
      DROP TABLE looks;
      DROP TABLE production_asset_images;
      DROP TABLE production_assets;
      PRAGMA user_version = 15;
      INSERT INTO projects VALUES (7, '旧项目', '水墨', '16:9'), (8, '外部项目', '电影', '9:16');
      INSERT INTO seasons VALUES (12, 7, '旧季', 1);
      INSERT INTO episodes VALUES (20, 12, '旧集', 1);
      INSERT INTO characters (id, project_id, name, age, appearance_notes) VALUES (40, 7, '旧演员', 28, '旧档案'), (41, 8, '外部演员', 25, '外部档案');
      INSERT INTO scenes VALUES (50, 7, '旧场景', '旧布局');
      INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (60, '全局API', 'image_to_image', 'http://127.0.0.1:1/v1', 'synthetic-migration-key', 'fixture-model');
      INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (20, '旧小说', '旧剧本', '旧说明', 2);
      INSERT INTO episode_extractions (episode_id, script_revision, revision, candidates) VALUES (20, 2, 3, '[]');
      INSERT INTO episode_occurrences (id, episode_id, kind, character_id, source_name, scene_heading, quote, source_start, mode, details, script_revision, revision, ignored, needs_review)
        VALUES (70, 20, 'character', 40, '旧演员', '1-1 房间 内 日', '旧依据', 0, 'on_screen', '旧备注', 2, 3, 0, 0);
      INSERT INTO episode_storyboards (episode_id, script_revision, revision, max_shot_seconds, reviewed, resources_json, shots)
        VALUES (20, 2, 4, 5, 1, '{"revision":"old-resource-hash","characters":[{"id":40}],"scenes":[]}', '[{"title":"当前镜头","duration":3.2,"characterIds":[40]}]');`);
    db.prepare("INSERT INTO character_references (id, character_id, image, mime, width, height) VALUES (80, 40, ?, 'image/png', 16, 9)").run(bytes);
    db.prepare("INSERT INTO character_boards (id, character_id, image, mime, width, height, valid, revision, model, prompt, reference_id) VALUES (81, 40, ?, 'image/png', 16, 9, 1, 'old-hash', 'fixture-model', 'old-prompt', 80)").run(bytes);
    db.prepare("INSERT INTO scene_references (id, scene_id, image, mime, width, height) VALUES (90, 50, ?, 'image/png', 16, 9)").run(bytes);
    db.prepare("INSERT INTO scene_images (id, scene_id, image, mime, width, height, valid, revision, model, prompt, reference_id) VALUES (91, 50, ?, 'image/png', 16, 9, 1, 'old-scene-hash', 'fixture-model', 'old-scene-prompt', 90)").run(bytes);
    const original = snapshot(db, oldTables), originalSchema = schema(db), originalSequences = sequences(db);
    db.close(); db = undefined;
    const exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('PRAGMA user_version = 16')) throw new Error('simulated looks migration failure');
      return result;
    });
    assert.throws(() => openDatabase(filename), /simulated looks migration failure/);
    t.mock.restoreAll();
    db = new DatabaseSync(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
    assert.deepEqual(snapshot(db, oldTables), original);
    assert.deepEqual(schema(db), originalSchema);
    assert.deepEqual(sequences(db), originalSequences);
    for (const table of newTables) assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table), undefined);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close(); db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(snapshot(db, oldTables), original);
    assert.deepEqual(snapshot(db, newTables), [[], [], [], [], []]);
    const a = asset(db), ai = assetImage(db, a), l = look(db), li = lookImage(db, l);
    db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(l, a);
    lookImage(db, l, 0); lookImage(db, l, 1, 1);
    const saved = snapshot(db, newTables);
    db.close(); db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    assert.deepEqual(snapshot(db, oldTables), original);
    assert.deepEqual(snapshot(db, newTables), saved);
    assert.equal(db.prepare('SELECT id FROM look_images WHERE valid = 1 AND cleared = 0').get().id, li);
    assert.equal(db.prepare('SELECT id FROM production_asset_images').get().id, ai);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { t.mock.restoreAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema16素材／定妆／图片ID删除重开后不复用；删除素材只解除关联、保留付费快照，演员／项目正确级联而全局API不动', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-looks-ids-')), filename = join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    db.exec("INSERT INTO projects VALUES (7, '本项目', '水墨', '16:9'), (8, '外部项目', '电影', '9:16'); INSERT INTO characters (id, project_id, name) VALUES (40, 7, '演员'), (41, 8, '外部演员'); INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES ('全局API', 'image_to_image', 'http://127.0.0.1:1/v1', 'synthetic-key', 'fixture-model')");
    const a = asset(db), ai = assetImage(db, a), l = look(db), li = lookImage(db, l);
    db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(l, a);
    const image = db.prepare('SELECT * FROM look_images WHERE id = ?').get(li);
    db.prepare('DELETE FROM production_assets WHERE id = ?').run(a);
    assert.deepEqual(db.prepare('SELECT * FROM look_assets').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM production_asset_images').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM look_images WHERE id = ?').get(li), image);
    assert.ok(db.prepare('SELECT id FROM looks WHERE id = ?').get(l));
    db.prepare('DELETE FROM looks WHERE id = ?').run(l);
    assert.ok(db.prepare('SELECT id FROM characters WHERE id = 40').get());
    assert.deepEqual(db.prepare('SELECT * FROM look_images').all(), []);
    db.close(); db = openDatabase(filename);
    const a2 = asset(db), ai2 = assetImage(db, a2), l2 = look(db), li2 = lookImage(db, l2);
    assert.ok(a2 > a); assert.ok(ai2 > ai); assert.ok(l2 > l); assert.ok(li2 > li);
    db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(l2, a2);
    const draft = look(db, 7, null), outside = look(db, 8, 41), outsideAsset = asset(db, 8);
    lookImage(db, draft); lookImage(db, outside); assetImage(db, outsideAsset);
    const configs = db.prepare('SELECT * FROM api_configs').all();
    db.exec('DELETE FROM characters WHERE id = 40');
    assert.equal(db.prepare('SELECT id FROM looks WHERE id = ?').get(l2), undefined);
    assert.equal(db.prepare('SELECT id FROM look_images WHERE id = ?').get(li2), undefined);
    assert.ok(db.prepare('SELECT id FROM production_assets WHERE id = ?').get(a2));
    assert.ok(db.prepare('SELECT id FROM looks WHERE id = ?').get(draft));
    db.exec('DELETE FROM projects WHERE id = 7');
    assert.deepEqual(db.prepare('SELECT id FROM looks').all().map(row => row.id), [outside]);
    assert.deepEqual(db.prepare('SELECT id FROM production_assets').all().map(row => row.id), [outsideAsset]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM look_images').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM production_asset_images').get().n, 1);
    assert.deepEqual(db.prepare('SELECT * FROM api_configs').all(), configs);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const saved = snapshot(db, newTables);
    db.close(); db = openDatabase(filename);
    assert.deepEqual(snapshot(db, newTables), saved);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema16归属外键、唯一关联及revision／分类／图片状态约束', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec("INSERT INTO projects VALUES (7, '约束测试', '水墨', '16:9'); INSERT INTO characters (id, project_id, name) VALUES (40, 7, '演员')");
    const a = asset(db), l = look(db); assetImage(db, a); lookImage(db, l);
    assert.throws(() => asset(db, 999), /FOREIGN KEY/);
    assert.throws(() => assetImage(db, 999), /FOREIGN KEY/);
    assert.throws(() => look(db, 999), /FOREIGN KEY/);
    assert.throws(() => look(db, 7, 999), /FOREIGN KEY/);
    assert.throws(() => lookImage(db, 999), /FOREIGN KEY/);
    db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(l, a);
    assert.throws(() => db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(l, a), /UNIQUE/);
    for (const pair of [[999, a], [l, 999]]) assert.throws(() => db.prepare('INSERT INTO look_assets VALUES (?, ?)').run(...pair), /FOREIGN KEY/);
    for (const table of ['production_assets', 'looks']) for (const value of [0, -1, 1.5, 'bad']) assert.throws(() => db.prepare(`UPDATE ${table} SET revision = ?`).run(value), /CHECK|datatype/);
    assert.throws(() => db.exec("UPDATE production_assets SET kind = 'scenes'"), /CHECK/);
    for (const table of ['production_asset_images', 'look_images']) {
      for (const [field, value] of [['mime', 'text/html'], ['width', 0], ['height', -1], ['cleared', 2]]) assert.throws(() => db.prepare(`UPDATE ${table} SET ${field} = ?`).run(value), /CHECK/);
      assert.throws(() => db.exec(`UPDATE ${table} SET image = NULL`), /NOT NULL/);
    }
    assert.throws(() => db.exec('UPDATE look_images SET valid = 2'), /CHECK/);
    assert.throws(() => db.exec('UPDATE look_images SET inputs_json = NULL'), /NOT NULL/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
