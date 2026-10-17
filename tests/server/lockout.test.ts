import { describe, expect, test } from "bun:test";
import { CLEARED_LOCKOUT, LOCKOUT_LOCK_MS, LOCKOUT_MAX_FAILS, LOCKOUT_WINDOW_MS, isLocked, recordFailure } from "../../src/server/auth/lockout.ts";

describe("lockout policy", () => {
  test("five failures inside the window lock for 15 minutes", () => {
    let s = CLEARED_LOCKOUT;
    const t0 = 1_000_000;
    for (let i = 0; i < LOCKOUT_MAX_FAILS - 1; i++) {
      s = recordFailure(s, t0 + i * 1000);
      expect(isLocked(s, t0 + i * 1000)).toBe(false);
    }
    s = recordFailure(s, t0 + 5000);
    expect(s.lockedUntil).toBe(t0 + 5000 + LOCKOUT_LOCK_MS);
    expect(isLocked(s, t0 + 5000)).toBe(true);
    expect(isLocked(s, t0 + 5000 + LOCKOUT_LOCK_MS)).toBe(false);
  });
  test("failures outside the window restart the count", () => {
    let s = recordFailure(CLEARED_LOCKOUT, 0);
    s = recordFailure(s, 1000);
    s = recordFailure(s, 2000);
    s = recordFailure(s, 3000);
    s = recordFailure(s, LOCKOUT_WINDOW_MS + 4000);
    expect(s.failedAttempts).toBe(1);
    expect(s.lockoutWindowStart).toBe(LOCKOUT_WINDOW_MS + 4000);
    expect(s.lockedUntil).toBeNull();
  });
  test("cleared state is not locked", () => {
    expect(isLocked(CLEARED_LOCKOUT, 0)).toBe(false);
  });
});
