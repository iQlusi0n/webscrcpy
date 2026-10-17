/**
 * Request-level defences (D9 layers 1–4): Host allowlist, Origin == Host, per-launch token cookie,
 * framing headers, body cap, and the loopback-only X-Forwarded-Proto trust.
 */
import { isIP } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildCookie, parseCookies, type CookieAttrs } from "./auth/session.ts";

export const TOKEN_COOKIE = "wsc_token";
export const MAX_BODY_BYTES = 1024 * 1024;

export type HttpDecision = { allowed: true; setTokenCookie: boolean } | { allowed: false; status: number; reason: string };

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "::1") return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return v4.startsWith("127.");
}

/** Hostname out of a Host header: strips port and IPv6 brackets. Null when unparseable. */
export function hostnameOf(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return null;
    const rest = h.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
    return h.slice(1, end);
  }
  const m = /^([^:/\\?#@\s]+)(?::(\d{1,5}))?$/.exec(h);
  return m?.[1] ?? null;
}

const TOP_LEVEL_DOC_METHODS: Record<string, true> = { GET: true, HEAD: true };

export interface SecurityOptions {
  allowedHosts: readonly string[];
  frameAncestors: readonly string[];
}

export class SecurityPolicy {
  private readonly token: Buffer;
  private readonly allowedHosts: Record<string, true> = {};
  readonly frameAncestors: readonly string[];
  private readonly cspValue: string | undefined;

  constructor(opts: SecurityOptions) {
    this.token = randomBytes(32);
    for (const h of opts.allowedHosts) {
      const n = h.trim().toLowerCase();
      if (n) this.allowedHosts[n] = true;
    }
    this.frameAncestors = opts.frameAncestors.map((o) => o.trim()).filter((o) => o.length > 0);
    this.cspValue = this.frameAncestors.length ? `frame-ancestors 'self' ${this.frameAncestors.join(" ")}` : undefined;
  }

  get tokenValue(): string {
    return this.token.toString("base64url");
  }

  isHostAllowed(host: string | null): boolean {
    if (host === null) return false;
    const name = hostnameOf(host);
    if (name === null) return false;
    if (name === "localhost" || name.endsWith(".localhost")) return true;
    if (isIP(name) !== 0) return true;
    return this.allowedHosts[name] === true;
  }

  isValidToken(provided: string | undefined): boolean {
    if (!provided) return false;
    let buf: Buffer;
    try {
      buf = Buffer.from(provided, "base64url");
    } catch {
      return false;
    }
    return buf.length === this.token.length && timingSafeEqual(buf, this.token);
  }

  /** Whether `X-Forwarded-Proto: https` (loopback peers only) or nothing marks this request secure. */
  isSecure(req: Request, peerIsLoopback: boolean): boolean {
    if (!peerIsLoopback) return false;
    const proto = req.headers.get("x-forwarded-proto");
    return proto !== null && proto.split(",")[0]?.trim().toLowerCase() === "https";
  }

  cookieAttrs(secure: boolean): CookieAttrs {
    return { secure, crossSite: secure && this.frameAncestors.length > 0 };
  }

  tokenCookie(secure: boolean): string {
    return buildCookie(TOKEN_COOKIE, this.tokenValue, "Strict", this.cookieAttrs(secure));
  }

  /** Layer 1–3 decision for an HTTP request (not an upgrade). */
  evaluateHttp(method: string, pathname: string, headers: Headers): HttpDecision {
    const host = headers.get("host");
    if (!this.isHostAllowed(host)) return { allowed: false, status: 403, reason: "host not allowed" };
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const safe = TOP_LEVEL_DOC_METHODS[method] === true;
    if (isApi || !safe) {
      const origin = headers.get("origin");
      if (origin !== null && !originMatchesHost(origin, host ?? "")) return { allowed: false, status: 403, reason: "origin mismatch" };
    }
    const tokenRequired = isApi && !(method === "GET" && pathname === "/api/config");
    if (tokenRequired && !this.isValidToken(parseCookies(headers.get("cookie"))[TOKEN_COOKIE])) {
      return { allowed: false, status: 403, reason: "missing or invalid token" };
    }
    return { allowed: true, setTokenCookie: safe && isDocumentPath(pathname) };
  }

  /** Decision for a WebSocket upgrade: Host, Origin (if present) and token are all enforced. */
  evaluateUpgrade(headers: Headers): HttpDecision {
    const host = headers.get("host");
    if (!this.isHostAllowed(host)) return { allowed: false, status: 403, reason: "host not allowed" };
    const origin = headers.get("origin");
    if (origin !== null && !originMatchesHost(origin, host ?? "")) return { allowed: false, status: 403, reason: "origin mismatch" };
    if (!this.isValidToken(parseCookies(headers.get("cookie"))[TOKEN_COOKIE])) return { allowed: false, status: 403, reason: "missing or invalid token" };
    return { allowed: true, setTokenCookie: false };
  }

  /** Headers every response carries. */
  applyHeaders(h: Headers): void {
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Frame-Options", "SAMEORIGIN");
    h.set("Referrer-Policy", "same-origin");
    if (this.cspValue !== undefined) h.set("Content-Security-Policy", this.cspValue);
  }
}

/** Origin's host[:port] must equal the Host header (case-insensitive, default ports normalised). */
export function originMatchesHost(origin: string, host: string): boolean {
  if (origin === "null") return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.host.toLowerCase() === host.trim().toLowerCase();
}

/** Extensionless paths and *.html get the token cookie (SPA documents); assets and API do not. */
export function isDocumentPath(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot < 0 || last.slice(dot + 1).toLowerCase() === "html";
}
