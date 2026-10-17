/** HTTP routes under /api/devices that need the adb daemon (api.ts shapes). */
import type {
  ConnectRequest,
  DeleteFilesRequest,
  DeleteFilesResponse,
  OkResponse,
  ScreenStateResponse,
  SleepWakeRequest,
} from "@common/api.ts";
import { isConnectAddress, isDeletablePath, isSerial } from "@common/validate.ts";
import type { Adb } from "@yume-chan/adb";
import { type AppRouter, type AppServices, HttpError, type RequestContext } from "../app.ts";
import { type AdbService, describe } from "./service.ts";

export const SCREEN_STATE_COMMAND =
  "dumpsys power 2>/dev/null | grep -m1 mWakefulness; dumpsys window 2>/dev/null | grep -m1 -i isKeyguardShowing";
const MAX_DELETE_PATHS = 1000;
const SLEEP_WAKE_SETTLE_MS = 500;
const KEYEVENT: Record<SleepWakeRequest["action"], string> = { sleep: "223", wake: "224" };

/** Defaults to awake/unlocked when a field is missing: absence must not read as a locked screen. */
export function parseScreenStateOutput(output: string): ScreenStateResponse {
  const awake = /mWakefulness=(\w+)/i.exec(output);
  const keyguard = /isKeyguardShowing=(true|false)/i.exec(output);
  return {
    awake: awake ? awake[1]?.toLowerCase() === "awake" : true,
    locked: keyguard ? keyguard[1]?.toLowerCase() === "true" : false,
  };
}

/** Own-property check: "constructor" / "__proto__" must not read through the prototype chain. */
export function isSleepWakeAction(value: unknown): value is SleepWakeRequest["action"] {
  return typeof value === "string" && Object.hasOwn(KEYEVENT, value);
}

export function registerRoutes(router: AppRouter, service: AdbService, services: AppServices): void {
  const log = services.log("devices");

  const wireless =
    (action: "connect" | "disconnect") =>
    async (ctx: RequestContext): Promise<Response> => {
      const { address } = (await ctx.json<Partial<ConnectRequest> | undefined>()) ?? {};
      if (!isConnectAddress(address)) throw new HttpError(400, "invalid address");
      try {
        if (action === "connect") await service.client.wireless.connect(address);
        else await service.client.wireless.disconnect(address);
        const body: OkResponse = { ok: true };
        return Response.json(body);
      } catch (error) {
        log.warn(`${action} ${address} failed: ${describe(error)}`);
        const body: OkResponse = { ok: false, message: describe(error) };
        return Response.json(body);
      }
    };
  router.route("POST", "/api/devices/connect", "auth", wireless("connect"));
  router.route("POST", "/api/devices/disconnect", "auth", wireless("disconnect"));

  const readScreenState = async (serial: string): Promise<ScreenStateResponse> =>
    parseScreenStateOutput(await service.shellText(serial, SCREEN_STATE_COMMAND));

  router.route("GET", "/api/devices/screen-state", "auth", async (ctx) => {
    const serial = ctx.url.searchParams.get("serial");
    if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
    try {
      return Response.json(await readScreenState(serial));
    } catch (error) {
      throw new HttpError(502, describe(error));
    }
  });

  router.route("POST", "/api/devices/sleep-wake", "auth", async (ctx) => {
    const { serial, action } = (await ctx.json<Partial<SleepWakeRequest> | undefined>()) ?? {};
    if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
    if (!isSleepWakeAction(action)) throw new HttpError(400, "invalid action");
    const keycode = KEYEVENT[action];
    try {
      const adb = await service.getAdb(serial);
      await adb.subprocess.noneProtocol.spawnWaitText(["input", "keyevent", keycode]);
      await Bun.sleep(SLEEP_WAKE_SETTLE_MS);
      const state = await readScreenState(serial);
      return Response.json({ awake: state.awake });
    } catch (error) {
      throw new HttpError(502, describe(error));
    }
  });

  router.route("POST", "/api/devices/files/delete", "auth", async (ctx) => {
    const { serial, paths } = (await ctx.json<Partial<DeleteFilesRequest> | undefined>()) ?? {};
    if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DELETE_PATHS)
      throw new HttpError(400, "paths must hold 1–1000 entries");
    if (!paths.every(isDeletablePath)) throw new HttpError(400, "path refused");
    let adb: Adb;
    try {
      adb = await service.getAdb(serial);
    } catch (error) {
      throw new HttpError(502, describe(error));
    }
    const errors: { path: string; error: string }[] = [];
    for (const path of paths) {
      try {
        const output = (await adb.rm(path, { recursive: true, force: true })).trim();
        if (output) errors.push({ path, error: output });
      } catch (error) {
        errors.push({ path, error: describe(error) });
      }
    }
    if (errors.length === 0) {
      const body: DeleteFilesResponse = { ok: true };
      return Response.json(body);
    }
    log.warn(`${serial}: ${errors.length}/${paths.length} deletions failed`);
    const body: DeleteFilesResponse = { ok: false, errors };
    return Response.json(body, { status: 207 });
  });
}
