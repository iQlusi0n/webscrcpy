import { WS_CLOSE_REASON_MAX_BYTES } from "@common/protocol.ts";
import type { AppSocket } from "../app.ts";

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
