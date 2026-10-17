/**
 * AuthService: one optional password. Mode 'password' when AUTH_PASSWORD is set or a hash is stored
 * in app_settings; otherwise 'off' (an authenticating reverse proxy is expected). In 'password'
 * mode every `auth`-gated route and every WS upgrade needs a valid `wsc_sid` session.
 */
import type { AuthMode } from "@common/api.ts";
import { type AppConfig, type Gate, HttpError } from "../app.ts";
import type { Stores } from "../db/index.ts";
import { CLEARED_LOCKOUT, isLocked, recordFailure } from "./lockout.ts";
import { BLIND_HASH, hashPassword, verifyPassword } from "./password.ts";
import {
  hashToken,
  newSessionToken,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from "./session.ts";

export interface Principal {
  mode: AuthMode;
  loggedIn: boolean;
  /** SHA-256 of the presented session token; undefined when not logged in */
  sessionKey?: string;
}

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterMs: number };

export class AuthService {
  /** Hash of AUTH_PASSWORD, computed once; undefined when the env var is absent. */
  private readonly envHash: string | undefined;

  constructor(
    private readonly stores: Stores,
    config: AppConfig,
  ) {
    this.envHash = config.authPasswordFromEnv === undefined ? undefined : hashPassword(config.authPasswordFromEnv);
  }

  get fromEnv(): boolean {
    return this.envHash !== undefined;
  }

  private currentHash(): string | null {
    return this.envHash ?? this.stores.settings.getApp("passwordHash");
  }

  mode(): AuthMode {
    return this.currentHash() === null ? "off" : "password";
  }

  /** Resolves the caller from the Cookie header, sliding the session on use. */
  resolve(req: Request, now = Date.now()): Principal {
    const mode = this.mode();
    if (mode === "off") return { mode, loggedIn: false };
    const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    if (!token) return { mode, loggedIn: false };
    const key = hashToken(token);
    const session = this.stores.sessions.get(key);
    if (!session) return { mode, loggedIn: false };
    if (session.expiresAt <= now) {
      this.stores.sessions.delete(key);
      return { mode, loggedIn: false };
    }
    if (now - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS)
      this.stores.sessions.touch(key, now, now + SESSION_TTL_MS);
    return { mode, loggedIn: true, sessionKey: key };
  }

  /** Throws HttpError(401) when `gate` is 'auth', mode is 'password' and no session was presented. */
  checkGate(gate: Gate, p: Principal): void {
    if (gate === "auth" && p.mode === "password" && !p.loggedIn) throw new HttpError(401, "authentication required");
  }

  login(password: string, now = Date.now()): LoginResult {
    const hash = this.currentHash();
    if (hash === null) {
      verifyPassword(password, BLIND_HASH);
      return { ok: false, reason: "invalid" };
    }
    const lockout = this.stores.settings.getApp("lockout") ?? CLEARED_LOCKOUT;
    if (isLocked(lockout, now)) {
      verifyPassword(password, BLIND_HASH); // same cost as a real check
      return { ok: false, reason: "locked", retryAfterMs: (lockout.lockedUntil ?? now) - now };
    }
    if (!verifyPassword(password, hash)) {
      const next = recordFailure(lockout, now);
      this.stores.settings.setApp("lockout", next);
      if (isLocked(next, now)) return { ok: false, reason: "locked", retryAfterMs: (next.lockedUntil ?? now) - now };
      return { ok: false, reason: "invalid" };
    }
    this.stores.settings.setApp("lockout", null);
    const token = newSessionToken();
    this.stores.sessions.create(hashToken(token), now, now + SESSION_TTL_MS);
    return { ok: true, token };
  }

  /** Revokes every session (there is one operator; logout means "log out everywhere"). */
  logoutAll(): void {
    this.stores.sessions.deleteAll();
  }

  /** Verifies the current password when one is stored. */
  verifyCurrent(password: string): boolean {
    const hash = this.currentHash();
    return hash !== null && verifyPassword(password, hash);
  }

  /** Stores a new password ('' clears it → mode 'off'). Drops every session either way. */
  setPassword(newPassword: string): void {
    if (this.fromEnv) throw new HttpError(409, "password is set by AUTH_PASSWORD and cannot be changed here");
    this.stores.db.transaction(() => {
      this.stores.settings.setApp("passwordHash", newPassword === "" ? null : hashPassword(newPassword));
      this.stores.settings.setApp("lockout", null);
      this.stores.sessions.deleteAll();
    })();
  }
}
