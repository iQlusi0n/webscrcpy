import { WS_CLOSE_REASON_MAX_BYTES, WsClose } from "@common/protocol.ts";
import type { AppServices, AppSocket } from "../app.ts";

/** Close with a protocol.ts code; the reason is trimmed to the RFC 6455 123-byte limit. */
export function closeWith(ws: AppSocket, code: number, reason?: string): void {
  if (ws.readyState > 1) return;
  if (reason === undefined) {
    ws.close(code);
    return;
  }
  const encoder = new TextEncoder();
  let text = reason.replace(/\s+/g, " ").trim();
  while (encoder.encode(text).byteLength > WS_CLOSE_REASON_MAX_BYTES) text = text.slice(0, -1);
  ws.close(code, text);
}

/** Resolves once `ws.getBufferedAmount()` drops below `limit`; `onDrain` must be wired to the drain handler. */
export class DrainWaiter {
  private waiters: (() => void)[] = [];

  onDrain(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  async waitBelow(ws: AppSocket, limit: number): Promise<void> {
    while (ws.readyState === 1 && ws.getBufferedAmount() > limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 250);
      });
    }
  }
}

/**
 * Open sockets on one endpoint. On shutdown each one is torn down through `release` (device-side
 * cleanup first, so SIGTERM doesn't strand tunnels or PTYs) and closed with GOING_AWAY.
 */
export class LiveSockets {
  private readonly sockets = new Set<AppSocket>();

  constructor(services: AppServices, release: (ws: AppSocket) => void) {
    services.onShutdown?.(() => {
      for (const ws of [...this.sockets]) {
        this.sockets.delete(ws);
        release(ws);
        closeWith(ws, WsClose.GOING_AWAY);
      }
    });
  }

  add(ws: AppSocket): void {
    this.sockets.add(ws);
  }

  delete(ws: AppSocket): void {
    this.sockets.delete(ws);
  }
}
