import { describe, expect, test } from "bun:test";
import {
  parseReloadStamps,
  RELOAD_MAX,
  RELOAD_WINDOW_MS,
  recordReload,
  shouldReload,
} from "../../src/app/ui/reconnectPolicy.ts";

describe("shouldReload", () => {
  test("only a refused upgrade (1006 before open) with the server reachable reloads", () => {
    expect(shouldReload({ code: 1006, neverOpened: true }, true)).toBe(true);
  });

  test("a live socket dropping with 1006 does not reload", () => {
    expect(shouldReload({ code: 1006, neverOpened: false }, true)).toBe(false);
  });

  test("4401 (password changed / logged out elsewhere) never reloads", () => {
    expect(shouldReload({ code: 4401, neverOpened: true }, true)).toBe(false);
    expect(shouldReload({ code: 4401, neverOpened: false }, true)).toBe(false);
  });

  test("server unreachable: leave it to the backoff loop", () => {
    expect(shouldReload({ code: 1006, neverOpened: true }, false)).toBe(false);
  });
});

describe("recordReload", () => {
  test("allows up to RELOAD_MAX reloads inside the window, then refuses", () => {
    let stamps: number[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < RELOAD_MAX; i++) {
      const next = recordReload(stamps, t0 + i * 1000);
      expect(next).not.toBeNull();
      stamps = next ?? [];
    }
    expect(stamps).toHaveLength(RELOAD_MAX);
    expect(recordReload(stamps, t0 + RELOAD_MAX * 1000)).toBeNull();
  });

  test("stamps older than the window are forgotten", () => {
    const t0 = 1_000_000;
    const full = Array.from({ length: RELOAD_MAX }, (_, i) => t0 + i);
    const later = recordReload(full, t0 + RELOAD_WINDOW_MS + RELOAD_MAX);
    expect(later).toEqual([t0 + RELOAD_WINDOW_MS + RELOAD_MAX]);
  });

  test("stamps from the future (clock moved back) are dropped", () => {
    expect(recordReload([5_000_000], 1_000)).toEqual([1_000]);
  });
});

describe("parseReloadStamps", () => {
  test("tolerates missing, malformed and mixed storage", () => {
    expect(parseReloadStamps(null)).toEqual([]);
    expect(parseReloadStamps("garbage")).toEqual([]);
    expect(parseReloadStamps('{"a":1}')).toEqual([]);
    expect(parseReloadStamps('[1,"x",2]')).toEqual([1, 2]);
  });
});
