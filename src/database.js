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
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
}
