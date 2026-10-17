/**
 * HTTP API contract. Pure module: browser + Bun. All bodies/responses are JSON.
 *
 * Auth model: a single optional password.
 *   mode 'off'      — no login; the operator is expected to put an authenticating reverse proxy
 *                     (Traefik/Caddy/nginx with forward-auth, basic auth, OIDC, …) in front.
 *   mode 'password' — one password, one session cookie; every /api and /ws route needs a session.
 * There are no users or roles. Gate column: public | auth (auth = session when mode is 'password').
 * Every /api/* request needs the per-launch token cookie and a matching Origin when present.
 */

import type { AudioCodec, AudioSource, VideoCodec } from "./scrcpy.ts";

export type AuthMode = "off" | "password";

/** GET /api/config — public, token-exempt (healthcheck). */
export interface ConfigResponse {
  version: string;
  scrcpyVersion: string;
  port: number;
  docker: boolean;
  adb: { ok: boolean; path?: string; version?: string; message?: string };
  auth: {
    mode: AuthMode;
    /** true when mode is 'password' and this request carries a valid session */
    loggedIn: boolean;
    /** password came from AUTH_PASSWORD env; cannot be changed in the UI */
    fromEnv: boolean;
  };
  /** request arrived from 127.0.0.1/::1 */
  callerIsLocal: boolean;
}

/** POST /api/auth/login {password} → 200 {ok:true} | 401 {ok:false, reason} */
export type LoginReason = "invalid" | "locked";
export interface LoginRequest {
  password: string;
}
export interface LoginResponse {
  ok: boolean;
  reason?: LoginReason;
  retryAfterMs?: number;
}
/** POST /api/auth/logout (auth) → {ok:true}; revokes every session and live socket */

/**
 * POST /api/auth/password (auth, or public while mode is 'off') {currentPassword?, newPassword}
 *   newPassword '' removes the password (mode → 'off'). currentPassword required when mode is
 *   'password'. 409 when the password is set from the environment.
 */
export interface SetPasswordRequest {
  currentPassword?: string;
  newPassword: string;
}

/** GET /api/settings → UserSettings ; PATCH /api/settings (partial) ; POST /api/settings/reset */
export interface UserSettings {
  theme?: "dark" | "light";
  [key: string]: unknown;
}

/** Per-device stream settings: GET/PATCH /api/settings/device?serial= */
export interface DeviceStreamSettings {
  videoCodec?: VideoCodec;
  videoEncoder?: string;
  audioEnabled?: boolean;
  audioCodec?: AudioCodec;
  audioSource?: AudioSource;
  bitrate?: number;
  maxFps?: number;
  maxSize?: number;
  displayId?: number;
  iFrameInterval?: number;
  codecOptions?: string;
  fitToScreen?: boolean;
}

/** GET /api/devices/labels → Record<serial,label> ; PUT /api/devices/labels {serial,label} ('' deletes) */
export interface LabelRequest {
  serial: string;
  label: string;
}

/** POST /api/devices/connect {address} ; POST /api/devices/disconnect {address} → {ok, message?} */
export interface ConnectRequest {
  address: string;
}
export interface OkResponse {
  ok: boolean;
  message?: string;
}

/** GET /api/devices/screen-state?serial= → {awake, locked} */
export interface ScreenStateResponse {
  awake: boolean;
  locked: boolean;
}
/** POST /api/devices/sleep-wake {serial, action:'sleep'|'wake'} → {awake} */
export interface SleepWakeRequest {
  serial: string;
  action: "sleep" | "wake";
}

/** POST /api/devices/files/delete {serial, paths[]} → 200 {ok:true} | 207 {ok:false, errors:[{path,error}]} | 400 */
export interface DeleteFilesRequest {
  serial: string;
  paths: string[];
}
export interface DeleteFilesResponse {
  ok: boolean;
  errors?: { path: string; error: string }[];
}

export interface ErrorResponse {
  error: string;
}
