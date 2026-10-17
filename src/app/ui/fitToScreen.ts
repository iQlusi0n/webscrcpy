import type { DeviceStreamSettings } from "@common/api.ts";

/** Upper bound the server accepts for maxSize (see server/adb/options.ts). */
const MAX_SIZE_CAP = 7680;

/**
 * "Fit to screen": derive scrcpy's max_size (the longer side of the encoded video) from the
 * browser window so the device never encodes more pixels than the page can show. The value is
 * rounded down to a multiple of 8 as scrcpy does, and capped to what the server accepts.
 */
export function fitMaxSize(viewportWidth: number, viewportHeight: number, devicePixelRatio: number): number {
  const longest = Math.max(viewportWidth, viewportHeight) * (devicePixelRatio > 0 ? devicePixelRatio : 1);
  if (!Number.isFinite(longest) || longest <= 0) return 0;
  return Math.min(MAX_SIZE_CAP, Math.floor(longest / 8) * 8);
}

/** Applies the fit-to-screen rule to saved settings; the explicit maxSize wins when it is off. */
export function resolveMaxSize(
  settings: DeviceStreamSettings,
  viewport: { width: number; height: number; dpr: number },
): DeviceStreamSettings {
  if (!settings.fitToScreen) return settings;
  return { ...settings, maxSize: fitMaxSize(viewport.width, viewport.height, viewport.dpr) };
}
