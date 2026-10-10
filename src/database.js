import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const database = new DatabaseSync(filename);
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
    database.exec('COMMIT');
    return database;
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
}
