import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/server/app.ts";
import { AuthService } from "../../src/server/auth/index.ts";
import { LOCKOUT_MAX_FAILS } from "../../src/server/auth/lockout.ts";
import { SESSION_COOKIE } from "../../src/server/auth/session.ts";
import { createStores, openDatabase } from "../../src/server/db/index.ts";

const baseConfig: AppConfig = { port: 8000, dataRoot: "/tmp", docker: false, allowedHosts: [], frameAncestors: [] };
const reqWith = (token?: string): Request =>
  new Request("http://localhost/", { headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {} });

describe("AuthService", () => {
  test("mode off: auth gate is open, login refused", () => {
    const auth = new AuthService(createStores(openDatabase(":memory:")), baseConfig);
    expect(auth.mode()).toBe("off");
    const p = auth.resolve(reqWith());
    expect(p.loggedIn).toBe(false);
    expect(() => auth.checkGate("auth", p)).not.toThrow();
    expect(auth.login("anything").ok).toBe(false);
  });

  test("password mode: gate needs a session; login issues one; logout revokes all", () => {
    const auth = new AuthService(createStores(openDatabase(":memory:")), baseConfig);
    auth.setPassword("correct horse");
    expect(auth.mode()).toBe("password");
    expect(() => auth.checkGate("auth", auth.resolve(reqWith()))).toThrow(/authentication/);
    expect(() => auth.checkGate("public", auth.resolve(reqWith()))).not.toThrow();
    const r = auth.login("correct horse");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = auth.resolve(reqWith(r.token));
    expect(p.loggedIn).toBe(true);
    expect(p.sessionKey).toBeString();
    auth.logoutAll();
    expect(auth.resolve(reqWith(r.token)).loggedIn).toBe(false);
  });

  test("env password wins and cannot be changed", () => {
    const auth = new AuthService(createStores(openDatabase(":memory:")), {
      ...baseConfig,
      authPasswordFromEnv: "from-env-pw",
    });
    expect(auth.fromEnv).toBe(true);
    expect(auth.login("from-env-pw").ok).toBe(true);
    expect(() => auth.setPassword("other")).toThrow();
  });

  test("lockout after repeated failures, cleared by success", () => {
    const auth = new AuthService(createStores(openDatabase(":memory:")), baseConfig);
    auth.setPassword("correct horse");
    let last = auth.login("wrong", 1000);
    for (let i = 1; i < LOCKOUT_MAX_FAILS; i++) last = auth.login("wrong", 1000 + i);
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.reason).toBe("locked");
    const locked = auth.login("correct horse", 2000);
    expect(locked.ok).toBe(false);
    if (!locked.ok && locked.reason === "locked") expect(locked.retryAfterMs).toBeGreaterThan(0);
    expect(auth.login("correct horse", 1000 + 16 * 60 * 1000).ok).toBe(true);
  });
});
