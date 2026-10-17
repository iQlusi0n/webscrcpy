/**
 * AppRouter implementation on `Bun.serve({ fetch, websocket })`: security layers, auth gates,
 * `:param` route matching, JSON error envelopes, WS upgrade with a live-socket registry so
 * logout / user-disable can close sockets with 4401.
 */

import { WsClose } from "@common/protocol.ts";
import type { Server, WebSocketHandler } from "bun";
import {
  type AppRouter,
  type AppSocket,
  type Gate,
  HttpError,
  type Logger,
  type RequestContext,
  type RouteHandler,
  type WsData,
  type WsHandlers,
} from "./app.ts";
import type { AuthService, Principal } from "./auth/index.ts";
import { type CookieAttrs, sessionCookie } from "./auth/session.ts";
import { isLoopbackAddress, MAX_BODY_BYTES, type SecurityPolicy } from "./security.ts";
import type { StaticFiles } from "./static.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What core route handlers get: the contract context plus what cookies need. */
export interface CoreContext extends RequestContext {
  principal: Principal;
  secure: boolean;
  cookieAttrs: CookieAttrs;
}

export type CoreRouteHandler = (ctx: CoreContext) => Promise<Response> | Response;

interface Route {
  method: Method;
  segments: string[];
  gate: Gate;
  handler: CoreRouteHandler;
}

interface WsRoute {
  gate: Gate;
  prepare: (ctx: RequestContext) => Promise<unknown> | unknown;
  handlers: WsHandlers;
}

export interface RouterDeps {
  auth: AuthService;
  security: SecurityPolicy;
  statics: StaticFiles;
  log: Logger;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * Live sockets indexed by session key, so logout can close them with 4401. Sockets opened without a
 * session (mode 'off') are tracked separately so turning a password on closes them too.
 */
export class SocketRegistry {
  private readonly bySession = new Map<string, Set<AppSocket>>();
  private readonly sessionless = new Set<AppSocket>();

  add(ws: AppSocket): void {
    const { sessionKey } = ws.data;
    if (sessionKey === undefined) {
      this.sessionless.add(ws);
      return;
    }
    let set = this.bySession.get(sessionKey);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionKey, set);
    }
    set.add(ws);
  }

  remove(ws: AppSocket): void {
    const { sessionKey } = ws.data;
    if (sessionKey === undefined) {
      this.sessionless.delete(ws);
      return;
    }
    const set = this.bySession.get(sessionKey);
    set?.delete(ws);
    if (set && set.size === 0) this.bySession.delete(sessionKey);
  }

  get size(): number {
    let n = this.sessionless.size;
    for (const set of this.bySession.values()) n += set.size;
    return n;
  }

  /** Every tracked socket: logout revokes all sessions at once, and a new password ends mode-'off' sockets. */
  closeAllSessions(reason = "logged out"): void {
    for (const set of [...this.bySession.values()]) {
      for (const ws of [...set]) ws.close(WsClose.UNAUTHORIZED, reason);
    }
    for (const ws of [...this.sessionless]) ws.close(WsClose.UNAUTHORIZED, reason);
  }
}

export class Router implements AppRouter {
  private readonly routes: Route[] = [];
  private readonly wsRoutes = new Map<string, WsRoute>();
  readonly sockets = new SocketRegistry();

  constructor(private readonly deps: RouterDeps) {}

  route(method: Method, pattern: string, gate: Gate, handler: RouteHandler): void {
    this.routes.push({ method, segments: pattern.split("/").filter((s) => s.length > 0), gate, handler });
  }

  /** Same as `route` but the handler sees the core context (cookie attributes, principal). */
  coreRoute(method: Method, pattern: string, gate: Gate, handler: CoreRouteHandler): void {
    this.routes.push({ method, segments: pattern.split("/").filter((s) => s.length > 0), gate, handler });
  }

  ws(path: string, gate: Gate, prepare: WsRoute["prepare"], handlers: WsHandlers): void {
    this.wsRoutes.set(path, { gate, prepare, handlers });
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i] ?? "";
        const part = parts[i] ?? "";
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private buildContext(
    req: Request,
    url: URL,
    params: Record<string, string>,
    principal: Principal,
    isLoopback: boolean,
    secure: boolean,
  ): CoreContext {
    return {
      req,
      url,
      params,
      loggedIn: principal.loggedIn,
      isLoopback,
      principal,
      secure,
      cookieAttrs: this.deps.security.cookieAttrs(secure),
      async json<T>(): Promise<T> {
        const declared = Number(req.headers.get("content-length") ?? "0");
        if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
        if (text.length === 0) throw new HttpError(400, "JSON body required");
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(400, "invalid JSON body");
        }
      },
    };
  }

  readonly fetch = async (req: Request, server: Server<WsData>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const peer = server.requestIP(req);
    const isLoopback = isLoopbackAddress(peer?.address);
    const secure = this.deps.security.isSecure(req, isLoopback);
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";

    // One canonical path for the security layers and the router: `//api/x` would otherwise skip the
    // `/api/` checks in evaluateHttp while still matching the route (match() drops empty segments).
    if (url.pathname.includes("//")) {
      const res = jsonResponse({ error: "not found" }, 404);
      this.deps.security.applyHeaders(res.headers);
      return res;
    }

    let res: Response;
    let setToken = false;
    try {
      if (isUpgrade) {
        const upgraded = await this.handleUpgrade(req, url, server, isLoopback, secure);
        if (upgraded === undefined) return undefined;
        res = upgraded;
      } else {
        const decision = this.deps.security.evaluateHttp(method, url.pathname, req.headers);
        if (!decision.allowed) {
          this.deps.log.warn(`${decision.status} ${method} ${url.pathname}: ${decision.reason}`);
          res = jsonResponse({ error: decision.reason }, decision.status);
        } else {
          setToken = decision.setTokenCookie;
          res = await this.handleHttp(req, url, method, isLoopback, secure);
        }
      }
    } catch (err) {
      res = this.errorResponse(err, method, url.pathname);
    }
    this.deps.security.applyHeaders(res.headers);
    if (setToken) res.headers.append("Set-Cookie", this.deps.security.tokenCookie(secure));
    return res;
  };

  private errorResponse(err: unknown, method: string, pathname: string): Response {
    if (err instanceof HttpError) return jsonResponse({ error: err.message }, err.status);
    this.deps.log.error(`unhandled error on ${method} ${pathname}`, err);
    return jsonResponse({ error: "internal error" }, 500);
  }

  private async handleHttp(
    req: Request,
    url: URL,
    method: string,
    isLoopback: boolean,
    secure: boolean,
  ): Promise<Response> {
    const matched = this.match(method, url.pathname);
    if (matched) {
      const principal = this.deps.auth.resolve(req);
      this.deps.auth.checkGate(matched.route.gate, principal);
      const ctx = this.buildContext(req, url, matched.params, principal, isLoopback, secure);
      const res = await matched.route.handler(ctx);
      // Sliding session: the DB expiry moved, so the browser's cookie lifetime must move with it.
      if (principal.renewedToken !== undefined)
        res.headers.append("Set-Cookie", sessionCookie(principal.renewedToken, ctx.cookieAttrs));
      return res;
    }
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (isApi) return jsonResponse({ error: "not found" }, 404);
    const file = await this.deps.statics.serve(method, url.pathname);
    return file ?? jsonResponse({ error: "not found" }, 404);
  }

  private async handleUpgrade(
    req: Request,
    url: URL,
    server: Server<WsData>,
    isLoopback: boolean,
    secure: boolean,
  ): Promise<Response | undefined> {
    const wsRoute = this.wsRoutes.get(url.pathname);
    if (!wsRoute) return jsonResponse({ error: "not found" }, 404);
    const decision = this.deps.security.evaluateUpgrade(req.headers);
    if (!decision.allowed) {
      this.deps.log.warn(`${decision.status} upgrade ${url.pathname}: ${decision.reason}`);
      return jsonResponse({ error: decision.reason }, decision.status);
    }
    const principal = this.deps.auth.resolve(req);
    this.deps.auth.checkGate(wsRoute.gate, principal);
    const ctx = this.buildContext(req, url, {}, principal, isLoopback, secure);
    const state = await wsRoute.prepare(ctx);
    const data: WsData = { kind: url.pathname.slice("/ws/".length), state };
    if (principal.sessionKey !== undefined) data.sessionKey = principal.sessionKey;
    if (server.upgrade(req, { data })) return undefined;
    return jsonResponse({ error: "upgrade failed" }, 500);
  }

  private handlersFor(ws: AppSocket): WsHandlers | undefined {
    return this.wsRoutes.get(`/ws/${ws.data.kind}`)?.handlers;
  }

  readonly websocket: WebSocketHandler<WsData> = {
    open: (ws) => {
      this.sockets.add(ws);
      const h = this.handlersFor(ws);
      if (!h) {
        ws.close(WsClose.BAD_REQUEST, "unknown endpoint");
        return;
      }
      void Promise.resolve(h.open(ws)).catch((err) => this.wsFailure(ws, "open", err));
    },
    message: (ws, data) => {
      const h = this.handlersFor(ws);
      if (!h) return;
      void Promise.resolve(h.message(ws, data)).catch((err) => this.wsFailure(ws, "message", err));
    },
    close: (ws, code, reason) => {
      this.sockets.remove(ws);
      const h = this.handlersFor(ws);
      if (!h) return;
      void Promise.resolve(h.close(ws, code, reason)).catch((err) =>
        this.deps.log.error(`ws ${ws.data.kind} close handler failed`, err),
      );
    },
    drain: (ws) => {
      this.handlersFor(ws)?.drain?.(ws);
    },
  };

  private wsFailure(ws: AppSocket, phase: string, err: unknown): void {
    this.deps.log.error(`ws ${ws.data.kind} ${phase} handler failed`, err);
    if (ws.readyState === WebSocket.OPEN)
      ws.close(WsClose.SESSION_FAILED, err instanceof Error ? err.message.slice(0, 120) : "internal error");
  }

  listen(port: number, hostname = "0.0.0.0"): Server<WsData> {
    return Bun.serve<WsData>({
      port,
      hostname,
      fetch: this.fetch,
      websocket: this.websocket,
      maxRequestBodySize: MAX_BODY_BYTES,
      development: false,
    });
  }
}
