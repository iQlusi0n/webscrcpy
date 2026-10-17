import type { ConfigResponse } from "@common/api.ts";
import type { DeviceDescriptor, DeviceListMessage } from "@common/protocol.ts";
import { WsClose } from "@common/protocol.ts";
import { api, wsUrl } from "../api.ts";
import type { AppContext } from "./context.ts";
import { DeviceCard } from "./deviceCard.ts";
import { parseReloadStamps, recordReload, type SocketClose, shouldReload } from "./reconnectPolicy.ts";

export interface DeviceListElements {
  grid: HTMLElement;
  empty: HTMLElement;
  adbBanner: HTMLElement;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const RELOAD_STORAGE_KEY = "ws-reloads";

/** Keeps the device grid in sync with /ws/devices and reconnects with backoff. */
export class DeviceList {
  private readonly devices = new Map<string, DeviceDescriptor>();
  private readonly cards = new Map<string, DeviceCard>();
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: number | undefined;
  /** the adb error to show whenever the socket is up; seeded from config, updated by `adb` messages */
  private adbError: string | null;

  constructor(
    private readonly els: DeviceListElements,
    private readonly ctx: AppContext,
  ) {
    this.adbError = adbErrorText(ctx.config.adb);
  }

  start(): void {
    this.stopped = false;
    this.setAdbBanner(this.adbError);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl("/ws/devices"));
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.attempts = 0;
      this.setAdbBanner(this.adbError);
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: DeviceListMessage;
      try {
        msg = JSON.parse(ev.data) as DeviceListMessage;
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      // Snapshot before scheduling: scheduleReconnect bumps `attempts` synchronously.
      const close: SocketClose = { code: ev.code, neverOpened: !opened };
      if (close.code === WsClose.UNAUTHORIZED || close.code === 1006) {
        void this.checkSession(close);
      }
      this.scheduleReconnect();
    });
  }

  /**
   * A refused upgrade: 4401 means our session is gone → back to the login view. 1006 before the
   * socket ever opened, with the server reachable, means the per-launch token changed (server
   * restarted): reload for a fresh cookie. GET /api/config is token-exempt, so it only proves the
   * server is up; reloads are capped (see reconnectPolicy) and otherwise we show a banner.
   */
  private async checkSession(close: SocketClose): Promise<void> {
    let cfg: ConfigResponse;
    try {
      cfg = await api.config();
    } catch {
      return; // server down; the reconnect loop keeps trying
    }
    if (this.stopped) return;
    if (cfg.auth.mode === "password" && !cfg.auth.loggedIn) {
      this.stop();
      this.ctx.config = cfg;
      this.ctx.restart();
      return;
    }
    if (!shouldReload(close, true)) return;
    const stamps = recordReload(parseReloadStamps(sessionStorage.getItem(RELOAD_STORAGE_KEY)), Date.now());
    if (!stamps) {
      clearTimeout(this.reconnectTimer);
      this.stopped = true;
      this.setAdbBanner(
        "the server keeps refusing the device list connection; check the reverse proxy forwards Host and Origin unchanged, then reload the page",
        "error",
      );
      return;
    }
    sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify(stamps));
    location.reload();
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 15000;
    this.attempts++;
    this.setAdbBanner(`device list disconnected; reconnecting in ${Math.round(delay / 1000)} s…`, "warning");
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private handle(msg: DeviceListMessage): void {
    switch (msg.type) {
      case "devices": {
        const seen = new Set<string>();
        for (const d of msg.devices) {
          seen.add(d.serial);
          this.upsert(d);
        }
        for (const serial of [...this.devices.keys()]) if (!seen.has(serial)) this.remove(serial);
        break;
      }
      case "device":
        this.upsert(msg.device);
        break;
      case "removed":
        this.remove(msg.serial);
        break;
      case "adb":
        this.adbError = adbErrorText(msg);
        this.setAdbBanner(this.adbError);
        break;
    }
    this.els.empty.classList.toggle("hidden", this.devices.size > 0);
  }

  private upsert(d: DeviceDescriptor): void {
    this.devices.set(d.serial, d);
    const existing = this.cards.get(d.serial);
    if (existing) {
      existing.update(d);
      return;
    }
    const card = new DeviceCard(d);
    this.cards.set(d.serial, card);
    this.els.grid.appendChild(card.el);
  }

  private remove(serial: string): void {
    this.devices.delete(serial);
    this.cards.get(serial)?.el.remove();
    this.cards.delete(serial);
  }

  private setAdbBanner(text: string | null, kind: "error" | "warning" = "error"): void {
    this.els.adbBanner.textContent = text ?? "";
    this.els.adbBanner.classList.toggle("hidden", text === null);
    this.els.adbBanner.classList.toggle("banner-error", kind === "error");
    this.els.adbBanner.classList.toggle("banner-warning", kind === "warning");
  }
}

function adbErrorText(adb: { ok: boolean; message?: string }): string | null {
  return adb.ok ? null : `adb not available: ${adb.message ?? "unknown error"}`;
}
