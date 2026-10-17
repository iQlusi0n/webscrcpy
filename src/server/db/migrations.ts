/** Forward-only schema migrations keyed by `PRAGMA user_version`. Single operator: no user ids. */
import type { Database } from "bun:sqlite";

const MIGRATIONS: readonly string[] = [
  // v1: initial schema
  `
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE device_settings (
    serial TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE device_labels (
    serial TEXT PRIMARY KEY,
    label TEXT NOT NULL
  );
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies every migration above the stored user_version, each in its own transaction. Idempotent. */
export function migrate(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema version ${version} is newer than this build supports (${SCHEMA_VERSION})`);
  }
  while (version < SCHEMA_VERSION) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;
    const next = version + 1;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next}`);
    })();
    version = next;
  }
  return version;
}
