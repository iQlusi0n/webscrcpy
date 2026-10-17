/**
 * Decides what the device list does after /ws/devices closes. Kept free of DOM so it is testable.
 *
 * A reload is only worth trying when the upgrade itself was refused (1006, the socket never
 * opened) while the server answers GET /api/config: that is the per-launch token changing after a
 * server restart. A live socket dropping with 1006 is just a network blip, and 4401 is handled by
 * the session check. Reloads are capped so a misconfigured proxy (e.g. Origin rewritten → 403)
 * cannot reload the page forever.
 */

export const RELOAD_MAX = 3;
export const RELOAD_WINDOW_MS = 10 * 60_000;

export interface SocketClose {
  code: number;
  /** the socket closed before `open` ever fired (refused upgrade) */
  neverOpened: boolean;
}

export function shouldReload(close: SocketClose, serverReachable: boolean): boolean {
  return close.code === 1006 && close.neverOpened && serverReachable;
}

/**
 * Returns the reload timestamps to persist when another reload is allowed inside the window, or
 * null when the cap is reached.
 */
export function recordReload(stamps: readonly number[], now: number): number[] | null {
  const recent = stamps.filter((t) => now - t < RELOAD_WINDOW_MS && t <= now);
  if (recent.length >= RELOAD_MAX) return null;
  recent.push(now);
  return recent;
}

export function parseReloadStamps(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === "number") : [];
  } catch {
    return [];
  }
}
