import { DatabaseSync } from 'node:sqlite';

export function inTransaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    if (database.prepare('PRAGMA user_version').get().user_version === 0) {
      const existing = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
      if (existing) database.exec('ALTER TABLE projects RENAME TO projects_previous');
      database.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          style TEXT NOT NULL,
          aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('9:16', '16:9', '21:9', '4:3', '3:4', '1:1'))
        )
      `);
      if (existing) {
        // SQLite 不能直接修改 CHECK 约束，在事务中重建表并保留项目 ID。
        database.exec(`
          INSERT INTO projects (id, name, style, aspect_ratio)
            SELECT id, name, style, aspect_ratio FROM projects_previous;
          DROP TABLE projects_previous;
        `);
      }
      database.exec('PRAGMA user_version = 1');
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 2) {
      database.exec(`
        CREATE TABLE seasons (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position > 0)
        );
        CREATE INDEX seasons_project_order ON seasons (project_id, position);
        CREATE TABLE episodes (
          id INTEGER PRIMARY KEY,
          season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position > 0)
        );
        CREATE INDEX episodes_season_order ON episodes (season_id, position);
        INSERT INTO seasons (project_id, name, position) SELECT id, '第一季', 1 FROM projects;
        PRAGMA user_version = 2;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 3) {
      database.exec(`
        CREATE TABLE characters (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          age INTEGER CHECK (age IS NULL OR (typeof(age) = 'integer' AND age >= 0)),
          gender_presentation TEXT NOT NULL DEFAULT '',
          skin_tone TEXT NOT NULL DEFAULT '',
          face_features TEXT NOT NULL DEFAULT '',
          hair_style TEXT NOT NULL DEFAULT '',
          hair_color TEXT NOT NULL DEFAULT '',
          height TEXT NOT NULL DEFAULT '',
          body_build TEXT NOT NULL DEFAULT '',
          body_proportions TEXT NOT NULL DEFAULT '',
          identity_features TEXT NOT NULL DEFAULT '',
          appearance_notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX characters_project ON characters (project_id, id);
        PRAGMA user_version = 3;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 4) {
      database.exec(`
        CREATE TABLE image_api_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL,
          model TEXT NOT NULL,
          size TEXT NOT NULL
        );
        PRAGMA user_version = 4;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 5) {
      // 保留已保存的角色板尺寸；通用 API 配置页不再设置业务尺寸。
      database.exec(`
        CREATE TABLE api_configs (
          type TEXT PRIMARY KEY NOT NULL CHECK (type IN ('text_to_image', 'llm', 'image_to_image', 'image_edit')),
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL,
          model TEXT NOT NULL,
          size TEXT
        );
        INSERT INTO api_configs (type, base_url, api_key, model, size)
          SELECT 'text_to_image', base_url, api_key, model, size FROM image_api_settings;
        DROP TABLE image_api_settings;
        PRAGMA user_version = 5;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 6) {
      database.exec(`
        ALTER TABLE api_configs RENAME TO api_configs_previous;
        CREATE TABLE api_configs (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('text_to_image', 'llm', 'image_to_image', 'image_edit')),
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL,
          model TEXT NOT NULL,
          size TEXT
        );
        INSERT INTO api_configs (name, type, base_url, api_key, model, size)
          SELECT CASE type WHEN 'text_to_image' THEN '文生图配置' WHEN 'llm' THEN '大语言模型配置'
            WHEN 'image_to_image' THEN '图生图配置' ELSE '编辑图片配置' END,
            type, base_url, api_key, model, size FROM api_configs_previous ORDER BY type;
        DROP TABLE api_configs_previous;
        CREATE INDEX api_configs_type ON api_configs (type, id);
        PRAGMA user_version = 6;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 7) {
      database.exec(`
        CREATE TABLE character_boards (
          id INTEGER PRIMARY KEY,
          character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
          image BLOB NOT NULL,
          mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
          width INTEGER NOT NULL CHECK (width > 0),
          height INTEGER NOT NULL CHECK (height > 0),
          valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
          revision TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX character_boards_character ON character_boards (character_id, valid, id);
        PRAGMA user_version = 7;
      `);
    }
    if (database.prepare('PRAGMA user_version').get().user_version < 8) {
      database.exec('ALTER TABLE character_boards ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)); PRAGMA user_version = 8;');
    }
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
}
