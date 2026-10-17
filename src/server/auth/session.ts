/** Session tokens: 32 random bytes to the browser, SHA-256 of them in the DB. Cookie `wsc_sid`, 30-day sliding. */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "wsc_sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only bump expiry when at least this much of the window has elapsed, to avoid a write per request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface CookieAttrs {
  secure: boolean;
  /** true when frameAncestors is configured and the request is secure → SameSite=None; Partitioned */
  crossSite: boolean;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Builds a Set-Cookie value. `defaultSameSite` is overridden to None when cross-site embedding is active. */
export function buildCookie(
  name: string,
  value: string,
  defaultSameSite: "Strict" | "Lax",
  attrs: CookieAttrs,
  maxAgeSeconds?: number,
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly"];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (attrs.crossSite) parts.push("SameSite=None", "Secure", "Partitioned");
  else {
    parts.push(`SameSite=${defaultSameSite}`);
    if (attrs.secure) parts.push("Secure");
  }
  return parts.join("; ");
}

export function sessionCookie(token: string, attrs: CookieAttrs): string {
  return buildCookie(SESSION_COOKIE, token, "Lax", attrs, Math.floor(SESSION_TTL_MS / 1000));
}

export function clearSessionCookie(attrs: CookieAttrs): string {
  return buildCookie(SESSION_COOKIE, "", "Lax", attrs, 0);
}
