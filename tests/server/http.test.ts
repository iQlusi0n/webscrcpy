import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { WsClose } from "../../src/common/protocol.ts";
import type { AppConfig, AppSocket, WsData } from "../../src/server/app.ts";
import { AuthService } from "../../src/server/auth/index.ts";
import { SESSION_COOKIE, SESSION_TOUCH_INTERVAL_MS } from "../../src/server/auth/session.ts";
import { createStores, openDatabase } from "../../src/server/db/index.ts";
import { jsonResponse, Router, SocketRegistry } from "../../src/server/http.ts";
import { SecurityPolicy, TOKEN_COOKIE } from "../../src/server/security.ts";
import { StaticFiles } from "../../src/server/static.ts";

const baseConfig: AppConfig = { port: 8000, dataRoot: "/tmp", docker: false, allowedHosts: [], frameAncestors: [] };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const fakeServer = {
  requestIP: () => ({ address: "127.0.0.1", port: 1, family: "IPv4" }),
} as unknown as Server<WsData>;

function makeRouter(): { router: Router; security: SecurityPolicy; auth: AuthService } {
  const stores = createStores(openDatabase(":memory:"));
  const auth = new AuthService(stores, baseConfig);
  const security = new SecurityPolicy({ allowedHosts: [], frameAncestors: [] });
  const router = new Router({ auth, security, statics: new StaticFiles("/nonexistent"), log: silent });
  router.coreRoute("GET", "/api/settings", "auth", () => jsonResponse({ hit: true }));
  router.coreRoute("POST", "/api/echo", "auth", async (ctx) => jsonResponse(await ctx.json()));
  return { router, security, auth };
}

function fakeSocket(sessionKey?: string): AppSocket & { closed: number[] } {
  const ws = {
    data: { kind: "stream", sessionKey } as WsData,
    closed: [] as number[],
    close(code: number) {
      this.closed.push(code);
    },
  };
  return ws as unknown as AppSocket & { closed: number[] };
}

describe("Router.fetch", () => {
  test("double-slash paths are 404 before the security layers can be skipped", async () => {
    const { router } = makeRouter();
    const res = await router.fetch(new Request("http://localhost:8000//api/settings"), fakeServer);
    expect(res?.status).toBe(404);
    expect(res?.headers.get("set-cookie")).toBeNull();
    const ok = await router.fetch(new Request("http://localhost:8000/api/settings"), fakeServer);
    expect(ok?.status).toBe(403); // token layer applies on the canonical path
  });

  test("ctx.json() rejects an empty body with 400", async () => {
    const { router, security } = makeRouter();
    const headers = { host: "localhost:8000", cookie: `${TOKEN_COOKIE}=${security.tokenValue}` };
    const empty = await router.fetch(
      new Request("http://localhost:8000/api/echo", { method: "POST", headers }),
      fakeServer,
    );
    expect(empty?.status).toBe(400);
    const bad = await router.fetch(
      new Request("http://localhost:8000/api/echo", { method: "POST", headers, body: "{nope" }),
      fakeServer,
    );
    expect(bad?.status).toBe(400);
  });

  test("session cookie is re-issued when the session slides", async () => {
    const { router, security, auth } = makeRouter();
    auth.setPassword("correct horse");
    const fresh = auth.login("correct horse", Date.now());
    const stale = auth.login("correct horse", Date.now() - SESSION_TOUCH_INTERVAL_MS - 1000);
    expect(fresh.ok && stale.ok).toBe(true);
    if (!fresh.ok || !stale.ok) return;
    const headersFor = (sid: string): Record<string, string> => ({
      host: "localhost:8000",
      cookie: `${TOKEN_COOKIE}=${security.tokenValue}; ${SESSION_COOKIE}=${sid}`,
    });
    const first = await router.fetch(
      new Request("http://localhost:8000/api/settings", { headers: headersFor(fresh.token) }),
      fakeServer,
    );
    expect(first?.status).toBe(200);
    expect(first?.headers.get("set-cookie")).toBeNull(); // within the touch interval: no header
    const slid = await router.fetch(
      new Request("http://localhost:8000/api/settings", { headers: headersFor(stale.token) }),
      fakeServer,
    );
    expect(slid?.status).toBe(200);
    expect(slid?.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=${stale.token}`);
    // touched once: the next request inside the interval carries no cookie again
    const again = await router.fetch(
      new Request("http://localhost:8000/api/settings", { headers: headersFor(stale.token) }),
      fakeServer,
    );
    expect(again?.headers.get("set-cookie")).toBeNull();
  });
});

describe("SocketRegistry", () => {
  test("sessionless sockets are tracked and closed with session sockets", () => {
    const reg = new SocketRegistry();
    const anon = fakeSocket();
    const withSession = fakeSocket("k1");
    reg.add(anon);
    reg.add(withSession);
    expect(reg.size).toBe(2);
    reg.closeAllSessions("password changed");
    expect(anon.closed).toEqual([WsClose.UNAUTHORIZED]);
    expect(withSession.closed).toEqual([WsClose.UNAUTHORIZED]);
    reg.remove(anon);
    reg.remove(withSession);
    expect(reg.size).toBe(0);
  });
});
