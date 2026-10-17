/**
 * webscrcpy server entrypoint: config → log → db → router → core routes → adb module → listen.
 * `webscrcpy --healthcheck` probes a running instance instead (Docker HEALTHCHECK, no curl).
 */
import { join } from "node:path";
import scrcpyServerAsset from "../../assets/scrcpy-server" with { type: "file" };
import pkg from "../../package.json" with { type: "json" };
import type { AdbStatus, AppServices } from "./app.ts";
import { registerAdb } from "./adb/index.ts";
import { AuthService } from "./auth/index.ts";
import { loadConfig, DEFAULT_PORT } from "./config.ts";
import { backupDatabase, createStores, DB_BACKUP_FILE_NAME, DB_FILE_NAME, openDatabase } from "./db/index.ts";
import { Router } from "./http.ts";
import { log } from "./log.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerConfigRoutes } from "./routes/config.ts";
import { registerLabelRoutes } from "./routes/labels.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { SecurityPolicy } from "./security.ts";
import { StaticFiles } from "./static.ts";
import "./embed.ts";

const HEALTHCHECK_TIMEOUT_MS = 4000;

async function healthcheck(): Promise<number> {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS) });
    return res.status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const mainLog = log("server");
  const dbPath = join(config.dataRoot, DB_FILE_NAME);
  const db = openDatabase(dbPath);
  const stores = createStores(db);
  const auth = new AuthService(stores, config);
  const security = new SecurityPolicy({ allowedHosts: config.allowedHosts, frameAncestors: config.frameAncestors });
  const statics = new StaticFiles();
  const router = new Router({ auth, security, statics, log: log("http") });

  let adbStatus: AdbStatus = { ok: false, message: "adb not initialised" };
  registerConfigRoutes(router, { config, auth, version: pkg.version, adbStatus: () => adbStatus });
  registerAuthRoutes(router, auth);
  registerSettingsRoutes(router, stores);
  registerLabelRoutes(router, stores);

  const services: AppServices = {
    db,
    config,
    log,
    labels: () => stores.labels.all(),
    scrcpyServerPath: async () => {
      if (config.scrcpyServerPath) {
        if (!(await Bun.file(config.scrcpyServerPath).exists())) throw new Error(`SCRCPY_SERVER_PATH not found: ${config.scrcpyServerPath}`);
        return config.scrcpyServerPath;
      }
      return scrcpyServerAsset;
    },
  };
  if (config.scrcpyServerPath) mainLog.warn(`using unverified scrcpy-server override: ${config.scrcpyServerPath}`);

  adbStatus = await registerAdb(router, services);
  if (adbStatus.ok) mainLog.info(`adb ${adbStatus.version ?? ""} at ${adbStatus.path ?? "(server)"}`.trim());
  else mainLog.error(`adb unavailable: ${adbStatus.message ?? "unknown reason"}`);

  stores.sessions.deleteExpired(Date.now());
  const server = router.listen(config.port);
  mainLog.info(`webscrcpy ${pkg.version} listening on http://localhost:${server.port}/`);
  mainLog.info(`data root: ${config.dataRoot}${statics.usesEmbedded ? " (embedded assets)" : ""}`);
  mainLog.info(auth.mode() === "off" ? "auth: off (put an authenticating reverse proxy in front for remote access)" : `auth: password${auth.fromEnv ? " (AUTH_PASSWORD)" : ""}`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    mainLog.info(`${signal} received, shutting down`);
    server.stop(true);
    try {
      backupDatabase(db, dbPath, join(config.dataRoot, DB_BACKUP_FILE_NAME));
    } catch (err) {
      mainLog.error("database backup failed", err);
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv.includes("--healthcheck")) {
  process.exit(await healthcheck());
}
await main();
