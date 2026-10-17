/** SQLite open/migrate/backup and the store bundle the rest of the server uses. */
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { migrate } from "./migrations.ts";
import { SessionStore } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { LabelStore } from "./labels.ts";

export const DB_FILE_NAME = "webscrcpy.db";
export const DB_BACKUP_FILE_NAME = "webscrcpy.db.bak";

export interface Stores {
  db: Database;
  sessions: SessionStore;
  settings: SettingsStore;
  labels: LabelStore;
}

/** Opens (or creates) the database, enables WAL, runs migrations. `":memory:"` works for tests. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function createStores(db: Database): Stores {
  return { db, sessions: new SessionStore(db), settings: new SettingsStore(db), labels: new LabelStore(db) };
}

/** Checkpoints the WAL and copies the main file to `backupPath`. */
export function backupDatabase(db: Database, dbPath: string, backupPath: string): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath, backupPath);
}
