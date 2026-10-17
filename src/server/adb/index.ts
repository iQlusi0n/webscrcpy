/** Wires the adb daemon, device tracker, stream/shell/files/probe sockets and device routes. */
import type { RegisterAdb } from "../app.ts";
import { registerFiles } from "./files.ts";
import { registerProbe } from "./probe.ts";
import { registerRoutes } from "./routes.ts";
import { registerStream } from "./scrcpy.ts";
import { describe, startAdbService } from "./service.ts";
import { registerShell } from "./shell.ts";
import { DeviceTracker, registerDevicesWs } from "./tracker.ts";

export const registerAdb: RegisterAdb = async (router, services) => {
  const log = services.log("adb");
  try {
    const { service, status } = await startAdbService(services.config, log);
    if (!service) {
      log.error(status.message ?? "adb unavailable");
      return status;
    }
    const tracker = new DeviceTracker(service, services.log("devices"));
    await tracker.start();
    registerDevicesWs(router, tracker, services);
    registerStream(router, service, services);
    registerProbe(router, service, services);
    registerShell(router, service, services);
    registerFiles(router, service, services);
    registerRoutes(router, service, services);
    return status;
  } catch (error) {
    log.error(`adb setup failed: ${describe(error)}`);
    return { ok: false, message: describe(error) };
  }
};
