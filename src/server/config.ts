/**
 * Boot-time configuration. Precedence: env > `<dataRoot>/config.json` > default.
 * Everything else (users, settings) lives in SQLite.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./app.ts";

export const DEFAULT_PORT = 8000;
export const APP_DIR_NAME = "webscrcpy";
export const CONFIG_FILE_NAME = "config.json";

/** The subset of AppConfig that config.json may carry. */
export interface FileConfig {
  port?: number;
  allowedHosts?: string[];
  frameAncestors?: string[];
}

export type Env = Record<string, string | undefined>;

export function resolveDataRoot(env: Env): string {
  const explicit = env.DATA_ROOT;
  if (explicit?.trim()) return resolve(explicit.trim());
  const xdg = env.XDG_DATA_HOME;
  if (xdg?.trim()) return join(resolve(xdg.trim()), APP_DIR_NAME);
  return join(homedir(), ".local", "share", APP_DIR_NAME);
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function parsePort(v: string | undefined): number | undefined {
  const t = nonEmpty(v);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be an integer in 1..65535, got "${t}"`);
  return n;
}

function parseCsv(v: string | undefined): string[] | undefined {
  const t = nonEmpty(v);
  if (t === undefined) return undefined;
  return t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stringList(v: unknown, key: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    throw new Error(`config.json: ${key} must be a string array`);
  return (v as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseFileConfig(text: string): FileConfig {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("config.json: top level must be an object");
  const o = raw as Record<string, unknown>;
  const out: FileConfig = {};
  if (o.port !== undefined) {
    const p = o.port;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535)
      throw new Error("config.json: port must be an integer in 1..65535");
    out.port = p;
  }
  const hosts = stringList(o.allowedHosts, "allowedHosts");
  if (hosts) out.allowedHosts = hosts;
  const ancestors = stringList(o.frameAncestors, "frameAncestors");
  if (ancestors) out.frameAncestors = ancestors;
  return out;
}

function readFileConfig(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseFileConfig(text);
}

/** Builds AppConfig from `env` and the config file; creates the data root. */
export function loadConfig(env: Env = process.env): AppConfig {
  const dataRoot = resolveDataRoot(env);
  // Holds the scrypt password hash and session hashes: owner-only (existing dirs keep their mode).
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const configPath = nonEmpty(env.CONFIG) ?? join(dataRoot, CONFIG_FILE_NAME);
  const file = readFileConfig(configPath);
  return {
    port: parsePort(env.PORT) ?? file.port ?? DEFAULT_PORT,
    dataRoot,
    docker: env.APP_DOCKER === "1",
    allowedHosts: parseCsv(env.ALLOWED_HOSTS) ?? file.allowedHosts ?? [],
    frameAncestors: file.frameAncestors ?? [],
    // Only emptiness is judged by trim(); the password itself is used verbatim (login bodies are not trimmed).
    authPasswordFromEnv: nonEmpty(env.AUTH_PASSWORD) === undefined ? undefined : env.AUTH_PASSWORD,
    adbPath: nonEmpty(env.ADB_PATH),
    adbServer: nonEmpty(env.ADB_SERVER),
    scrcpyServerPath: nonEmpty(env.SCRCPY_SERVER_PATH),
  };
}
