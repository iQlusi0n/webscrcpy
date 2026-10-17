import type { Database } from "bun:sqlite";

export interface SessionRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

interface SessionRow {
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(tokenHash: string, now: number, expiresAt: number): void {
    this.db.run("INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)", [
      tokenHash,
      now,
      expiresAt,
      now,
    ]);
  }

  get(tokenHash: string): SessionRecord | null {
    const r = this.db
      .query<SessionRow, [string]>(
        "SELECT token_hash, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ?",
      )
      .get(tokenHash);
    return r
      ? { tokenHash: r.token_hash, createdAt: r.created_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at }
      : null;
  }

  /** Sliding expiry: bumps expires_at and last_seen_at. */
  touch(tokenHash: string, now: number, expiresAt: number): void {
    this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?", [
      now,
      expiresAt,
      tokenHash,
    ]);
  }

  delete(tokenHash: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
  }

  deleteAll(): void {
    this.db.run("DELETE FROM sessions");
  }

  deleteExpired(now: number): number {
    return this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]).changes;
  }
}
