import { describe, expect, test } from "bun:test";
import { SecurityPolicy, TOKEN_COOKIE, hostnameOf, isDocumentPath, isLoopbackAddress, originMatchesHost } from "../../src/server/security.ts";

const policy = new SecurityPolicy({ allowedHosts: ["app.example.com"], frameAncestors: [] });
const headers = (h: Record<string, string>): Headers => new Headers(h);
const withToken = (extra: Record<string, string> = {}): Headers => headers({ host: "localhost:8000", cookie: `${TOKEN_COOKIE}=${policy.tokenValue}`, ...extra });

describe("host allowlist", () => {
  test("accepts localhost, IP literals and configured hosts", () => {
    expect(policy.isHostAllowed("localhost:8000")).toBe(true);
    expect(policy.isHostAllowed("127.0.0.1")).toBe(true);
    expect(policy.isHostAllowed("[::1]:8000")).toBe(true);
    expect(policy.isHostAllowed("192.168.1.5:8000")).toBe(true);
    expect(policy.isHostAllowed("APP.example.com")).toBe(true);
  });
  test("rejects foreign, missing or malformed hosts", () => {
    expect(policy.isHostAllowed("evil.com")).toBe(false);
    expect(policy.isHostAllowed(null)).toBe(false);
    expect(policy.isHostAllowed("")).toBe(false);
    expect(policy.isHostAllowed("[::1")).toBe(false);
  });
  test("hostnameOf strips ports and brackets", () => {
    expect(hostnameOf("Example.com:80")).toBe("example.com");
    expect(hostnameOf("[fe80::1]:8000")).toBe("fe80::1");
  });
  test("every request is refused on a bad host, even documents", () => {
    const d = policy.evaluateHttp("GET", "/", headers({ host: "evil.com" }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.status).toBe(403);
  });
});

describe("origin check", () => {
  test("applies to /api and non-GET only", () => {
    const bad = { origin: "http://evil.com" };
    expect(policy.evaluateHttp("GET", "/index.js", headers({ host: "localhost:8000", ...bad })).allowed).toBe(true);
    expect(policy.evaluateHttp("GET", "/api/config", headers({ host: "localhost:8000", ...bad })).allowed).toBe(false);
    expect(policy.evaluateHttp("POST", "/anything", headers({ host: "localhost:8000", ...bad })).allowed).toBe(false);
  });
  test("same origin passes; absent origin passes", () => {
    expect(policy.evaluateHttp("POST", "/api/x", withToken({ origin: "http://localhost:8000" })).allowed).toBe(true);
    expect(policy.evaluateHttp("POST", "/api/x", withToken()).allowed).toBe(true);
  });
  test("originMatchesHost", () => {
    expect(originMatchesHost("http://LOCALHOST:8000", "localhost:8000")).toBe(true);
    expect(originMatchesHost("null", "localhost:8000")).toBe(false);
    expect(originMatchesHost("ftp://localhost:8000", "localhost:8000")).toBe(false);
    expect(originMatchesHost("garbage", "localhost:8000")).toBe(false);
  });
});

describe("token", () => {
  test("required on /api except GET /api/config", () => {
    expect(policy.evaluateHttp("GET", "/api/config", headers({ host: "localhost" })).allowed).toBe(true);
    expect(policy.evaluateHttp("POST", "/api/config", headers({ host: "localhost" })).allowed).toBe(false);
    expect(policy.evaluateHttp("GET", "/api/users", headers({ host: "localhost" })).allowed).toBe(false);
    expect(policy.evaluateHttp("GET", "/api/users", withToken()).allowed).toBe(true);
  });
  test("wrong token is rejected", () => {
    const h = headers({ host: "localhost", cookie: `${TOKEN_COOKIE}=${"A".repeat(43)}` });
    expect(policy.evaluateHttp("GET", "/api/users", h).allowed).toBe(false);
    expect(policy.isValidToken("short")).toBe(false);
    expect(policy.isValidToken(undefined)).toBe(false);
  });
  test("set on documents, not assets or api", () => {
    const doc = policy.evaluateHttp("GET", "/", headers({ host: "localhost" }));
    expect(doc.allowed && doc.setTokenCookie).toBe(true);
    const asset = policy.evaluateHttp("GET", "/index.js", headers({ host: "localhost" }));
    expect(asset.allowed && asset.setTokenCookie).toBe(false);
    expect(isDocumentPath("/foo.html")).toBe(true);
    expect(isDocumentPath("/api/config")).toBe(false);
    expect(isDocumentPath("/index.css")).toBe(false);
  });
  test("WS upgrade requires host, origin match and token", () => {
    expect(policy.evaluateUpgrade(headers({ host: "localhost" })).allowed).toBe(false);
    expect(policy.evaluateUpgrade(withToken({ origin: "http://evil.com" })).allowed).toBe(false);
    expect(policy.evaluateUpgrade(withToken({ origin: "http://localhost:8000" })).allowed).toBe(true);
  });
});

describe("cookies and forwarded proto", () => {
  test("X-Forwarded-Proto trusted only from loopback", () => {
    const req = new Request("http://localhost/", { headers: { "x-forwarded-proto": "https" } });
    expect(policy.isSecure(req, true)).toBe(true);
    expect(policy.isSecure(req, false)).toBe(false);
    expect(policy.isSecure(new Request("http://localhost/"), true)).toBe(false);
  });
  test("token cookie attributes", () => {
    expect(policy.tokenCookie(false)).toBe(`${TOKEN_COOKIE}=${policy.tokenValue}; Path=/; HttpOnly; SameSite=Strict`);
    expect(policy.tokenCookie(true)).toContain("; Secure");
    const framed = new SecurityPolicy({ allowedHosts: [], frameAncestors: ["https://embedder.example"] });
    expect(framed.tokenCookie(true)).toContain("SameSite=None; Secure; Partitioned");
    expect(framed.tokenCookie(false)).toContain("SameSite=Strict");
  });
  test("security headers", () => {
    const h = new Headers();
    policy.applyHeaders(h);
    expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Content-Security-Policy")).toBeNull();
    const framed = new SecurityPolicy({ allowedHosts: [], frameAncestors: ["https://a.example"] });
    const h2 = new Headers();
    framed.applyHeaders(h2);
    expect(h2.get("Content-Security-Policy")).toBe("frame-ancestors 'self' https://a.example");
  });
  test("loopback detection", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
