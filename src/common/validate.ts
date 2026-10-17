/** Allowlist validators for every string that reaches adb or the device. Pure module. */

/** adb serial: USB serials, emulator-5554, host:port, or [v6]:port. */
const SERIAL_RE = /^(?:[A-Za-z0-9._:\-\[\]]{1,128})$/;
export function isSerial(s: unknown): s is string {
  return typeof s === "string" && SERIAL_RE.test(s) && !s.startsWith("-");
}

/** host[:port] for adb connect; rejects leading '-' (argv injection) and whitespace. */
const CONNECT_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,253})|\[[0-9A-Fa-f:.]+\])(?::(?:[1-9]\d{0,4}))?$/;
export function isConnectAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 300 || !CONNECT_RE.test(s)) return false;
  const port = s.includes("]") ? s.split("]:")[1] : s.split(":")[1];
  return port === undefined || Number(port) <= 65535;
}

/** MediaCodec encoder name passed into app_process argv. */
export const ENCODER_RE = /^[A-Za-z0-9_.\-]{1,128}$/;
export function isEncoderName(s: unknown): s is string {
  return typeof s === "string" && ENCODER_RE.test(s);
}

/** scrcpy codec options: key[:type]=value,... */
export const CODEC_OPTIONS_RE = /^[A-Za-z0-9_.:,=\-]{1,256}$/;
export function isCodecOptions(s: unknown): s is string {
  return typeof s === "string" && CODEC_OPTIONS_RE.test(s);
}

export const VIDEO_CODECS = ["h264", "h265", "av1", "vp8", "vp9"] as const;
export const AUDIO_CODECS = ["opus", "aac", "flac", "raw"] as const;
export const AUDIO_SOURCES = ["output", "mic", "playback"] as const;

export function parseIntInRange(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** Absolute device path with no '.'/'..' segments or NUL. */
export function isDevicePath(p: unknown): p is string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || p.length > 4096) return false;
  return !p.split("/").some((seg) => seg === "." || seg === "..");
}

/** Absolute host filesystem path handed to Bun.spawn (the adb binary). */
export function isHostExecutablePath(p: unknown): p is string {
  return typeof p === "string" && p.startsWith("/") && p.length <= 4096 && !/[\0\r\n]/.test(p);
}

export const PROTECTED_DELETE_ROOTS: Record<string, true> = {
  "/": true, "/sdcard": true, "/storage": true, "/storage/emulated": true, "/storage/emulated/0": true,
  "/data": true, "/system": true, "/vendor": true, "/mnt": true, "/proc": true, "/dev": true,
};
export function isDeletablePath(p: unknown): p is string {
  if (!isDevicePath(p)) return false;
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  return PROTECTED_DELETE_ROOTS[trimmed] !== true;
}

export function isUsername(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9._\-]{1,64}$/.test(s);
}
