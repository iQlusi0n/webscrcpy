import type { DeviceStreamSettings, UserSettings } from "@common/api.ts";
import type { AudioCodec, AudioSource, VideoCodec } from "@common/scrcpy.ts";
import {
  AUDIO_CODECS,
  AUDIO_SOURCES,
  isCodecOptions,
  isEncoderName,
  isSerial,
  parseIntInRange,
  VIDEO_CODECS,
} from "@common/validate.ts";
import { HttpError } from "../app.ts";
import type { Stores } from "../db/index.ts";
import { jsonResponse, type Router } from "../http.ts";

export const MAX_USER_SETTINGS_KEYS = 64;
const MAX_USER_SETTING_BYTES = 16 * 1024;
const USER_SETTING_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Pass the regex but would alter the object itself rather than store a value. */
const PROTOTYPE_KEYS: Record<string, true> = Object.fromEntries(
  ["__proto__", "constructor", "prototype"].map((k) => [k, true]),
);

const VIDEO_CODEC_SET: Record<string, true> = Object.fromEntries(VIDEO_CODECS.map((c) => [c, true]));
const AUDIO_CODEC_SET: Record<string, true> = Object.fromEntries(AUDIO_CODECS.map((c) => [c, true]));
const AUDIO_SOURCE_SET: Record<string, true> = Object.fromEntries(AUDIO_SOURCES.map((c) => [c, true]));

/**
 * Validates a PATCH body against the key grammar, per-value size and the cap on the total number of
 * stored keys (`existingKeys` ∪ added − removed ≤ MAX_USER_SETTINGS_KEYS).
 */
export function validateUserPatch(body: unknown, existingKeys: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError(400, "object body required");
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_USER_SETTINGS_KEYS) throw new HttpError(400, "too many keys");
  const resulting = new Set(existingKeys);
  for (const [key, value] of entries) {
    if (!USER_SETTING_KEY_RE.test(key) || PROTOTYPE_KEYS[key] === true)
      throw new HttpError(400, `invalid key "${key}"`);
    if (key === "theme" && value !== undefined && value !== null && value !== "dark" && value !== "light")
      throw new HttpError(400, "theme must be dark|light");
    if (JSON.stringify(value ?? null).length > MAX_USER_SETTING_BYTES)
      throw new HttpError(400, `value for "${key}" too large`);
    if (value === null || value === undefined) resulting.delete(key);
    else resulting.add(key);
  }
  if (resulting.size > MAX_USER_SETTINGS_KEYS) throw new HttpError(400, "too many keys");
  return body as Record<string, unknown>;
}

type FieldValidator = (v: unknown) => DeviceStreamSettings[keyof DeviceStreamSettings] | undefined;

/** Each field's parser returns undefined when the value is unacceptable. */
const DEVICE_FIELDS: Record<keyof DeviceStreamSettings, FieldValidator> = {
  videoCodec: (v) => (typeof v === "string" && VIDEO_CODEC_SET[v] === true ? (v as VideoCodec) : undefined),
  audioCodec: (v) => (typeof v === "string" && AUDIO_CODEC_SET[v] === true ? (v as AudioCodec) : undefined),
  audioSource: (v) => (typeof v === "string" && AUDIO_SOURCE_SET[v] === true ? (v as AudioSource) : undefined),
  videoEncoder: (v) => (isEncoderName(v) ? v : undefined),
  codecOptions: (v) => (isCodecOptions(v) ? v : undefined),
  audioEnabled: (v) => (typeof v === "boolean" ? v : undefined),
  fitToScreen: (v) => (typeof v === "boolean" ? v : undefined),
  bitrate: (v) => parseIntInRange(v, 100_000, 200_000_000),
  maxFps: (v) => parseIntInRange(v, 1, 240),
  maxSize: (v) => parseIntInRange(v, 0, 8192),
  displayId: (v) => parseIntInRange(v, 0, 1_000_000),
  iFrameInterval: (v) => parseIntInRange(v, 0, 3600),
};

/**
 * Merges `patch` into `current`; `null`/`""` clears a field. Every string reaches app_process argv
 * later, so it is allowlisted here (D9 rule 6). Returns the next stored value.
 */
export function mergeDeviceSettings(current: DeviceStreamSettings, patch: unknown): DeviceStreamSettings {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    throw new HttpError(400, "object body required");
  const next: Record<string, unknown> = { ...current };
  for (const [key, v] of Object.entries(patch as Record<string, unknown>)) {
    const validate = DEVICE_FIELDS[key as keyof DeviceStreamSettings];
    if (!Object.hasOwn(DEVICE_FIELDS, key) || !validate) throw new HttpError(400, `unknown field "${key}"`);
    if (v === null || v === undefined || v === "") {
      delete next[key];
      continue;
    }
    const parsed = validate(v);
    if (parsed === undefined) throw new HttpError(400, `invalid ${key}`);
    next[key] = parsed;
  }
  return next as DeviceStreamSettings;
}

function serialParam(url: URL): string {
  const serial = url.searchParams.get("serial");
  if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
  return serial;
}

export function registerSettingsRoutes(router: Router, stores: Stores): void {
  const { settings } = stores;

  router.coreRoute("GET", "/api/settings", "auth", () => {
    const body: UserSettings = settings.getUserSettings();
    return jsonResponse(body);
  });

  router.coreRoute("PATCH", "/api/settings", "auth", async (ctx) => {
    const patch = validateUserPatch(await ctx.json<unknown>(), Object.keys(settings.getUserSettings()));
    return jsonResponse(settings.patchUserSettings(patch));
  });

  router.coreRoute("POST", "/api/settings/reset", "auth", () => {
    settings.resetUserSettings();
    return jsonResponse({ ok: true });
  });

  router.coreRoute("GET", "/api/settings/device", "auth", (ctx) =>
    jsonResponse(settings.getDeviceSettings(serialParam(ctx.url))),
  );

  router.coreRoute("PATCH", "/api/settings/device", "auth", async (ctx) => {
    const serial = serialParam(ctx.url);
    const next = mergeDeviceSettings(settings.getDeviceSettings(serial), await ctx.json<unknown>());
    settings.setDeviceSettings(serial, next);
    return jsonResponse(next);
  });
}
