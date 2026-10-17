/** scrypt (N=16384, r=8, p=1) password hashes: `scrypt$N$r$p$<salt b64>$<key b64>`. */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Hash of a random secret; verified against on unknown-user logins so timing matches a real check. */
export const BLIND_HASH = hashPassword(randomBytes(SALT_BYTES).toString("hex"));

/** Constant-time compare; returns false (after a real scrypt run when parseable) on any malformed hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const key = scryptSync(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(key, expected);
}

export function isAcceptablePassword(p: unknown): p is string {
  return typeof p === "string" && p.length >= MIN_PASSWORD_LENGTH && p.length <= MAX_PASSWORD_LENGTH;
}
