import type { ConfigResponse } from "@common/api.ts";
import { SCRCPY_VERSION } from "@common/scrcpy.ts";
import type { AdbStatus, AppConfig } from "../app.ts";
import type { AuthService } from "../auth/index.ts";
import { jsonResponse, type Router } from "../http.ts";

export interface ConfigRouteDeps {
  config: AppConfig;
  auth: AuthService;
  version: string;
  /** read at request time so the adb status can change after startup */
  adbStatus(): AdbStatus;
}

export function registerConfigRoutes(router: Router, deps: ConfigRouteDeps): void {
  router.coreRoute("GET", "/api/config", "public", (ctx) => {
    const body: ConfigResponse = {
      version: deps.version,
      scrcpyVersion: SCRCPY_VERSION,
      port: deps.config.port,
      docker: deps.config.docker,
      adb: deps.adbStatus(),
      auth: { mode: ctx.principal.mode, loggedIn: ctx.principal.loggedIn, fromEnv: deps.auth.fromEnv },
      callerIsLocal: ctx.isLoopback,
    };
    return jsonResponse(body, 200, { "Cache-Control": "no-store" });
  });
}
