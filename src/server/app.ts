/**
 * Server composition contract. ServerCore implements `AppRouter`/`AppServices` and calls
 * `registerAdb(router, services)` from src/server/adb/index.ts at startup. The ADB/stream
 * module only ever touches the server through these interfaces.
 */
import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";

/** 'auth' requires a session when the password mode is on; identical to 'public' when off. */
export type Gate = "public" | "auth";

export interface RequestContext {
  req: Request;
  url: URL;
  /** path params from the route pattern, e.g. "/api/settings/:key" → { key } */
  params: Record<string, string>;
  /** true when a valid session cookie was presented (always false in mode 'off') */
  loggedIn: boolean;
  isLoopback: boolean;
  /** parsed JSON body (≤ 1 MiB); throws HttpError(400/413) on bad input */
  json<T>(): Promise<T>;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

/** Per-socket data attached at upgrade time. */
export interface WsData {
  kind: string;
  /** session token hash so logout can revoke; undefined in mode 'off' */
  sessionKey?: string;
  /** module-private state */
  state?: unknown;
}

export type AppSocket = ServerWebSocket<WsData>;

export interface WsHandlers {
  open(ws: AppSocket): void | Promise<void>;
  message(ws: AppSocket, data: string | Buffer): void | Promise<void>;
  close(ws: AppSocket, code: number, reason: string): void | Promise<void>;
  /** backpressure relief: ws.getBufferedAmount() dropped */
  drain?(ws: AppSocket): void;
}

export interface AppRouter {
  /** pattern supports ":param" segments; first registered match wins */
  route(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", pattern: string, gate: Gate, handler: RouteHandler): void;
  /**
   * WebSocket endpoint at an exact path. `prepare` runs after the gate and may reject with
   * HttpError or return module state stored on `ws.data.state`.
   */
  ws(path: string, gate: Gate, prepare: (ctx: RequestContext) => Promise<unknown> | unknown, handlers: WsHandlers): void;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface AppConfig {
  port: number;
  dataRoot: string;
  docker: boolean;
  allowedHosts: string[];
  frameAncestors: string[];
  /** AUTH_PASSWORD env: fixed password, not changeable from the UI */
  authPasswordFromEnv?: string;
  /** explicit adb binary path, or undefined → search PATH */
  adbPath?: string;
  /** host:port of an external adb server, or undefined → 127.0.0.1:5037 (start if absent) */
  adbServer?: string;
  /** override for the bundled scrcpy-server, unverified */
  scrcpyServerPath?: string;
}

export interface AppServices {
  db: Database;
  config: AppConfig;
  log(tag: string): Logger;
  /** device labels (single operator, so not per-user) */
  labels(): Record<string, string>;
  /** absolute path to the scrcpy-server jar to push (bundled asset or override) */
  scrcpyServerPath(): Promise<string>;
}

/** Implemented by src/server/adb/index.ts. */
export type RegisterAdb = (router: AppRouter, services: AppServices) => Promise<AdbStatus>;
export interface AdbStatus {
  ok: boolean;
  path?: string;
  version?: string;
  message?: string;
}
