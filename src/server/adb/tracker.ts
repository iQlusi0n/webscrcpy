/**
 * Device list via `host:track-devices`, enriched with props, kind and screen state.
 * Emits DeviceListMessage (without labels; `/ws/devices` adds the per-user label).
 */

import type { DeviceDescriptor, DeviceKind, DeviceListMessage, DeviceState, ScreenState } from "@common/protocol.ts";
import type { AdbServerClient } from "@yume-chan/adb";
import type { AppRouter, AppServices, AppSocket, Logger } from "../app.ts";
import { parseWmDensity, parseWmSize } from "./probe.ts";
import { type AdbService, describe } from "./service.ts";

const EMIT_THROTTLE_MS = 300;
const SCREEN_POLL_MS = 5_000;
const DETAIL_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const TRACK_RETRY_MS = 3_000;
const SEPARATOR = "::";

const DETAILS_COMMAND = [
  "getprop ro.product.manufacturer",
  "getprop ro.product.model",
  "getprop ro.build.version.release",
  "getprop ro.build.version.sdk",
  "getprop ro.build.characteristics",
  "pm has-feature android.software.leanback 2>/dev/null",
  "wm size",
  "wm density",
].join(`; echo '${SEPARATOR}'; `);

export type DeviceListener = (message: DeviceListMessage) => void;

export interface DeviceDetails {
  manufacturer?: string;
  model?: string;
  androidVersion?: string;
  sdk?: number;
  kind: DeviceKind;
}

/** Pure: parse the combined output of DETAILS_COMMAND. */
export function parseDeviceDetails(output: string): DeviceDetails {
  const parts = output.split(SEPARATOR).map((part) => part.trim());
  const [manufacturer, model, release, sdkText, characteristics = "", leanback = "", sizeOut = "", densityOut = ""] =
    parts;
  const sdk = Number.parseInt(sdkText ?? "", 10);
  const details: DeviceDetails = { kind: classifyKind(characteristics, leanback, sizeOut, densityOut) };
  if (manufacturer) details.manufacturer = manufacturer;
  if (model) details.model = model;
  if (release) details.androidVersion = release;
  if (Number.isFinite(sdk) && sdk > 0) details.sdk = sdk;
  return details;
}

export function classifyKind(characteristics: string, leanback: string, wmSize: string, wmDensity: string): DeviceKind {
  if (/\btv\b/.test(characteristics) || leanback.trim() === "true") return "tv";
  const size = parseWmSize(wmSize);
  const density = parseWmDensity(wmDensity);
  if (!size || !density || density <= 0) return "phone";
  const shortestDp = Math.min(size.width, size.height) / (density / 160);
  return shortestDp >= 600 ? "tablet" : "phone";
}

export function parseScreenState(output: string): ScreenState {
  const match = /mWakefulness=(\w+)/i.exec(output);
  if (!match) return "unknown";
  return match[1]?.toLowerCase() === "awake" ? "awake" : "asleep";
}

export class DeviceTracker {
  private readonly devices = new Map<string, DeviceDescriptor>();
  private readonly listeners = new Set<DeviceListener>();
  private readonly pending = new Set<string>();
  private readonly detailsInFlight = new Set<string>();
  private flushTimer: Timer | undefined;
  private pollTimer: Timer | undefined;
  private observer: AdbServerClient.DeviceObserver | undefined;
  private daemonOk = true;
  private stopped = false;

  constructor(
    private readonly service: AdbService,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.observer = await this.service.client.trackDevices();
    this.observer.onListChange((list) => this.reconcile(list));
    this.observer.onError((error) => this.onDaemonLost(error));
    this.reconcile(this.observer.current);
  }

  snapshot(): DeviceDescriptor[] {
    return [...this.devices.values()];
  }

  subscribe(listener: DeviceListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startScreenPoll();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopScreenPoll();
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopScreenPoll();
    clearTimeout(this.flushTimer);
    await this.observer?.stop();
  }

  private reconcile(list: readonly AdbServerClient.Device[]): void {
    const seen = new Set<string>();
    for (const entry of list) {
      seen.add(entry.serial);
      const state: DeviceState = entry.state;
      const existing = this.devices.get(entry.serial);
      if (!existing) {
        this.devices.set(entry.serial, {
          serial: entry.serial,
          state,
          isNetwork: /:\d+$/.test(entry.serial),
          screen: "unknown",
        });
        this.pending.add(entry.serial);
        this.scheduleFlush();
      } else if (existing.state !== state) {
        existing.state = state;
        if (state !== "device") existing.screen = "unknown";
        this.pending.add(entry.serial);
        this.scheduleFlush();
      }
      const current = this.devices.get(entry.serial);
      if (current && state === "device" && current.sdk === undefined) void this.fetchDetails(entry.serial);
    }
    for (const serial of [...this.devices.keys()]) {
      if (seen.has(serial)) continue;
      this.devices.delete(serial);
      this.pending.delete(serial);
      this.service.drop(serial);
      this.emit({ type: "removed", serial });
    }
  }

  private async fetchDetails(serial: string): Promise<void> {
    if (this.detailsInFlight.has(serial)) return;
    this.detailsInFlight.add(serial);
    try {
      for (let attempt = 0; attempt <= DETAIL_BACKOFF_MS.length; attempt += 1) {
        const device = this.devices.get(serial);
        if (device?.state !== "device" || this.stopped) return;
        try {
          const adb = await this.service.getAdb(serial);
          const output = await adb.subprocess.noneProtocol.spawnWaitText(DETAILS_COMMAND);
          const details = parseDeviceDetails(output);
          const target = this.devices.get(serial);
          if (!target) return;
          Object.assign(target, details);
          if (details.sdk !== undefined) this.service.cacheFor(serial).sdk = Promise.resolve(details.sdk);
          this.pending.add(serial);
          this.scheduleFlush();
          return;
        } catch (error) {
          const delay = DETAIL_BACKOFF_MS[attempt];
          if (delay === undefined) {
            this.log.warn(`giving up on device details for ${serial}: ${describe(error)}`);
            return;
          }
          this.log.debug(`device details for ${serial} failed (${describe(error)}); retry in ${delay} ms`);
          await Bun.sleep(delay);
        }
      }
    } finally {
      this.detailsInFlight.delete(serial);
    }
  }

  private startScreenPoll(): void {
    if (this.pollTimer) return;
    void this.pollScreens();
    this.pollTimer = setInterval(() => void this.pollScreens(), SCREEN_POLL_MS);
  }

  private stopScreenPoll(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async pollScreens(): Promise<void> {
    const targets = [...this.devices.values()].filter((device) => device.state === "device");
    await Promise.all(
      targets.map(async (device) => {
        let screen: ScreenState;
        try {
          const adb = await this.service.getAdb(device.serial);
          screen = parseScreenState(
            await adb.subprocess.noneProtocol.spawnWaitText("dumpsys power 2>/dev/null | grep -m1 mWakefulness"),
          );
        } catch {
          screen = "unknown";
        }
        const current = this.devices.get(device.serial);
        if (!current || current.screen === screen) return;
        current.screen = screen;
        this.pending.add(device.serial);
        this.scheduleFlush();
      }),
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const serials = [...this.pending];
      this.pending.clear();
      for (const serial of serials) {
        const device = this.devices.get(serial);
        if (device) this.emit({ type: "device", device });
      }
    }, EMIT_THROTTLE_MS);
  }

  private emit(message: DeviceListMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        this.log.warn(`device listener threw: ${describe(error)}`);
      }
    }
  }

  private onDaemonLost(error: Error): void {
    if (!this.daemonOk || this.stopped) return;
    this.daemonOk = false;
    this.log.error(`adb device tracking lost: ${error.message}`);
    this.emit({ type: "adb", ok: false, message: error.message });
    for (const serial of [...this.devices.keys()]) {
      this.devices.delete(serial);
      this.service.drop(serial);
      this.emit({ type: "removed", serial });
    }
    this.pending.clear();
    void this.retryTracking();
  }

  private async retryTracking(): Promise<void> {
    while (!this.stopped) {
      await Bun.sleep(TRACK_RETRY_MS);
      try {
        await this.observer?.stop();
      } catch {
        // already gone
      }
      try {
        await this.start();
        this.daemonOk = true;
        this.log.info("adb device tracking restored");
        this.emit({ type: "adb", ok: true });
        return;
      } catch (error) {
        this.log.debug(`adb still unreachable: ${describe(error)}`);
      }
    }
  }
}

export function registerDevicesWs(router: AppRouter, tracker: DeviceTracker, services: AppServices): void {
  router.ws("/ws/devices", "auth", () => undefined, {
    open(ws: AppSocket) {
      const withLabel = (device: DeviceDescriptor): DeviceDescriptor => {
        const label = services.labels()[device.serial];
        return label === undefined ? { ...device } : { ...device, label };
      };
      const send = (message: DeviceListMessage): void => {
        if (ws.readyState !== 1) return;
        ws.send(
          JSON.stringify(message.type === "device" ? { ...message, device: withLabel(message.device) } : message),
        );
      };
      send({ type: "devices", devices: tracker.snapshot().map(withLabel) });
      ws.data.state = tracker.subscribe(send);
    },
    message() {},
    close(ws: AppSocket) {
      const unsubscribe = ws.data.state as (() => void) | undefined;
      unsubscribe?.();
    },
  });
}
