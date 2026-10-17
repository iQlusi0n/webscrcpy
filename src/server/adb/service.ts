/**
 * Connection to the host `adb` daemon (Tango server transport) plus a per-serial cache of
 * `Adb` handles, SDK level and probed encoder lists. Everything else in this module gets
 * device access through here.
 */

import type { ProbeResult } from "@common/protocol.ts";
import { isConnectAddress, isHostExecutablePath } from "@common/validate.ts";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import type { AdbStatus, AppConfig, Logger } from "../app.ts";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 5037;
const START_SERVER_TIMEOUT_MS = 15_000;

export interface DeviceCache {
  adb?: Promise<Adb>;
  sdk?: Promise<number>;
  /** MediaCodec audio encoder names from the last probe; [] = unknown */
  audioEncoders?: Promise<string[]>;
  probe?: ProbeResult;
}

export interface AdbServiceStart {
  service?: AdbService;
  status: AdbStatus;
}

export class AdbService {
  readonly client: AdbServerClient;
  private readonly devices = new Map<string, DeviceCache>();

  constructor(
    client: AdbServerClient,
    private readonly log: Logger,
  ) {
    this.client = client;
  }

  cacheFor(serial: string): DeviceCache {
    let entry = this.devices.get(serial);
    if (!entry) {
      entry = {};
      this.devices.set(serial, entry);
    }
    return entry;
  }

  /** Cached `Adb` for a serial; recreated after the transport reports a disconnect. */
  getAdb(serial: string): Promise<Adb> {
    const entry = this.cacheFor(serial);
    if (entry.adb) return entry.adb;
    const created = this.client.createTransport({ serial }).then((transport) => {
      const adb = new Adb(transport);
      void transport.disconnected.then(() => {
        // Only forget the entry this transport belongs to; a re-plugged device may already have a new one.
        if (entry.adb === created && this.devices.get(serial) === entry) {
          this.log.debug(`transport for ${serial} disconnected`);
          this.devices.delete(serial);
        }
      });
      return adb;
    });
    entry.adb = created;
    created.catch(() => {
      if (entry.adb === created) entry.adb = undefined;
    });
    return created;
  }

  getSdk(serial: string): Promise<number> {
    const entry = this.cacheFor(serial);
    if (entry.sdk) return entry.sdk;
    const sdk = this.getAdb(serial).then(async (adb) => {
      const value = Number.parseInt(await adb.getProp("ro.build.version.sdk"), 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`unreadable ro.build.version.sdk for ${serial}`);
      return value;
    });
    entry.sdk = sdk;
    sdk.catch(() => {
      if (entry.sdk === sdk) entry.sdk = undefined;
    });
    return sdk;
  }

  /**
   * Run `command` through a one-shot `shell:` socket and return its output. Unlike
   * `adb.subprocess`, this does not go through the cached transport, whose socket list only
   * shrinks on close — so periodic polls don't accumulate dead sockets for the device's lifetime.
   */
  async shellText(serial: string, command: string): Promise<string> {
    const socket = await this.client.createDeviceConnection({ serial }, `shell:${command}`);
    const decoder = new TextDecoder();
    let text = "";
    try {
      const reader = socket.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await Promise.resolve(socket.close()).catch(() => undefined);
    }
    return text;
  }

  /** Forget everything about a serial (device unplugged). Closes the transport. */
  drop(serial: string): void {
    const entry = this.devices.get(serial);
    this.devices.delete(serial);
    if (!entry?.adb) return;
    void entry.adb.then((adb) => adb.close()).catch(() => undefined);
  }
}

function locateAdb(configured: string | undefined): string | undefined {
  if (configured !== undefined) return isHostExecutablePath(configured) ? configured : undefined;
  const found = Bun.which("adb");
  return found !== null && isHostExecutablePath(found) ? found : undefined;
}

function serverSpec(adbServer: string | undefined): { host: string; port: number } | undefined {
  if (adbServer === undefined) return { host: DEFAULT_SERVER_HOST, port: DEFAULT_SERVER_PORT };
  if (!isConnectAddress(adbServer)) return undefined;
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(adbServer);
  if (!match) return undefined;
  const host = match[1] ?? match[2] ?? DEFAULT_SERVER_HOST;
  const port = match[3] !== undefined ? Number(match[3]) : DEFAULT_SERVER_PORT;
  return { host, port };
}

async function startDaemon(adbPath: string, log: Logger): Promise<string | undefined> {
  log.info(`adb daemon not reachable; running ${adbPath} start-server`);
  const proc = Bun.spawn([adbPath, "start-server"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), START_SERVER_TIMEOUT_MS);
  try {
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) return `adb start-server exited with ${code}: ${err.trim()}`;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Locate adb, reach (or start) the daemon and verify its protocol version.
 * Never throws: failures come back as `status.ok === false`.
 */
export async function startAdbService(config: AppConfig, log: Logger): Promise<AdbServiceStart> {
  const spec = serverSpec(config.adbServer);
  if (!spec) return { status: { ok: false, message: `invalid ADB_SERVER address: ${config.adbServer}` } };
  const adbPath = locateAdb(config.adbPath);
  const external = config.adbServer !== undefined;
  if (!adbPath && !external) {
    return {
      status: {
        ok: false,
        message:
          "adb not found on PATH. Install platform-tools (apt install adb / brew install android-platform-tools) or set ADB_PATH.",
      },
    };
  }
  const client = new AdbServerClient(new AdbServerNodeTcpConnector({ host: spec.host, port: spec.port }));
  let version: number;
  try {
    version = await client.getVersion();
  } catch (first) {
    if (external || !adbPath) {
      return {
        status: {
          ok: false,
          path: adbPath,
          message: `cannot reach adb server at ${spec.host}:${spec.port}: ${describe(first)}`,
        },
      };
    }
    const startError = await startDaemon(adbPath, log);
    if (startError) return { status: { ok: false, path: adbPath, message: startError } };
    try {
      version = await client.getVersion();
    } catch (second) {
      return {
        status: { ok: false, path: adbPath, message: `adb server started but is unreachable: ${describe(second)}` },
      };
    }
  }
  log.info(`adb server ${spec.host}:${spec.port} protocol version ${version}${adbPath ? ` (${adbPath})` : ""}`);
  return { service: new AdbService(client, log), status: { ok: true, path: adbPath, version: String(version) } };
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
