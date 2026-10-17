/** Login lockout: 5 failures inside a 5-minute window lock the account for 15 minutes. Pure. */

export interface LockoutState {
  failedAttempts: number;
  lockoutWindowStart: number | null;
  lockedUntil: number | null;
}

export const LOCKOUT_MAX_FAILS = 5;
export const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
export const LOCKOUT_LOCK_MS = 15 * 60 * 1000;

export const CLEARED_LOCKOUT: LockoutState = { failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null };

export function isLocked(s: LockoutState, now: number): boolean {
  return s.lockedUntil !== null && now < s.lockedUntil;
}

export function recordFailure(s: LockoutState, now: number): LockoutState {
  let windowStart = s.lockoutWindowStart;
  let fails = s.failedAttempts;
  if (windowStart === null || now - windowStart > LOCKOUT_WINDOW_MS) {
    windowStart = now;
    fails = 0;
  }
  fails += 1;
  return {
    failedAttempts: fails,
    lockoutWindowStart: windowStart,
    lockedUntil: fails >= LOCKOUT_MAX_FAILS ? now + LOCKOUT_LOCK_MS : null,
  };
}
