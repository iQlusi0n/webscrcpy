/**
 * Typed same-origin fetch wrapper over the routes in @common/api.ts.
 * Every call sends cookies, speaks JSON and throws ApiError on non-2xx.
 */
import type {
  ConfigResponse,
  ConnectRequest,
  DeleteFilesRequest,
  DeleteFilesResponse,
  DeviceStreamSettings,
  LabelRequest,
  LoginRequest,
  LoginResponse,
  OkResponse,
  ScreenStateResponse,
  SetPasswordRequest,
  SleepWakeRequest,
  UserSettings,
} from "@common/api.ts";

export class ApiError extends Error {
  readonly status: number;
  /** parsed JSON body when the server sent one */
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Called on every 401 from a non-login route so the shell can drop to the login view. */
let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "include", headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "network error", null);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      message = parsed.error;
    }
    if (res.status === 401 && path !== "/api/auth/login") unauthorizedHandler?.();
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Builds a same-origin WebSocket URL for a `/ws/*` endpoint. */
export function wsUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}${query(params)}`;
}

/** Login replies 401 with a body; surface it as a value rather than an error. */
export async function login(body: LoginRequest): Promise<LoginResponse> {
  try {
    return await request<LoginResponse>("POST", "/api/auth/login", body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.body && typeof err.body === "object" && "ok" in err.body) {
      const b = err.body;
      const reason = "reason" in b && (b.reason === "invalid" || b.reason === "locked") ? b.reason : undefined;
      const retryAfterMs = "retryAfterMs" in b && typeof b.retryAfterMs === "number" ? b.retryAfterMs : undefined;
      const out: LoginResponse = { ok: false };
      if (reason) out.reason = reason;
      if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
      return out;
    }
    throw err;
  }
}

export const api = {
  config: () => request<ConfigResponse>("GET", "/api/config"),
  auth: {
    login,
    logout: () => request<OkResponse>("POST", "/api/auth/logout"),
    setPassword: (body: SetPasswordRequest) => request<OkResponse>("POST", "/api/auth/password", body),
  },
  settings: {
    get: () => request<UserSettings>("GET", "/api/settings"),
    patch: (body: Partial<UserSettings>) => request<UserSettings>("PATCH", "/api/settings", body),
    reset: () => request<OkResponse>("POST", "/api/settings/reset"),
    device: (serial: string) => request<DeviceStreamSettings>("GET", `/api/settings/device${query({ serial })}`),
    patchDevice: (serial: string, body: DeviceStreamSettings) =>
      request<DeviceStreamSettings>("PATCH", `/api/settings/device${query({ serial })}`, body),
  },
  devices: {
    labels: () => request<Record<string, string>>("GET", "/api/devices/labels"),
    setLabel: (body: LabelRequest) => request<OkResponse>("PUT", "/api/devices/labels", body),
    connect: (body: ConnectRequest) => request<OkResponse>("POST", "/api/devices/connect", body),
    disconnect: (body: ConnectRequest) => request<OkResponse>("POST", "/api/devices/disconnect", body),
    screenState: (serial: string) =>
      request<ScreenStateResponse>("GET", `/api/devices/screen-state${query({ serial })}`),
    sleepWake: (body: SleepWakeRequest) => request<{ awake: boolean }>("POST", "/api/devices/sleep-wake", body),
    /** 207 is a success status for fetch, so partial failures arrive as a normal body. */
    deleteFiles: (body: DeleteFilesRequest) => request<DeleteFilesResponse>("POST", "/api/devices/files/delete", body),
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
