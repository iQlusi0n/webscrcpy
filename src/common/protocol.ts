/**
 * Browser ⇄ server WebSocket contracts. Pure module: browser + Bun.
 *
 * Every WebSocket endpoint lives under `/ws/<kind>`; the per-launch token cookie is required
 * on the upgrade (security.ts). Endpoints:
 *
 *   /ws/devices                      JSON text frames, DeviceListMessage (server → browser)
 *   /ws/stream?serial=…&…            binary frames, 1-byte channel prefix (see ChannelId)
 *   /ws/shell?serial=…               binary frames = raw pty bytes; text frames = ShellClientMessage
 *   /ws/files?serial=…               JSON text frames (FilesRequest/FilesResponse) + binary frames for data
 *   /ws/probe?serial=…               one JSON text frame (ProbeResult) then close
 */

import type { AudioCodec, AudioSource, VideoCodec } from "./scrcpy.ts";

// ---------------------------------------------------------------- stream channel mux

/** First byte of every binary frame on /ws/stream. */
export const ChannelId = {
  /** server→browser: [8B ptsAndFlags][4B size][data] — mirrors scrcpy's media packet */
  VIDEO: 0,
  /** server→browser: same framing as VIDEO */
  AUDIO: 1,
  /** browser→server: raw scrcpy control message (control_msg.h), forwarded verbatim */
  CONTROL: 2,
  /** server→browser: raw bytes from the device side of the control socket; browser reassembles */
  DEVICE_MSG: 3,
  /** server→browser: UTF-8 JSON StreamMetadata, exactly once after sockets are up */
  METADATA: 4,
  /** server→browser: UTF-8 JSON SessionChange on rotation / resize */
  SESSION: 5,
} as const;
export type ChannelIdValue = (typeof ChannelId)[keyof typeof ChannelId];

export interface StreamMetadata {
  deviceName: string;
  videoCodec: VideoCodec;
  /** 'disabled' when the device could not capture audio; 'error' on config failure */
  audioCodec: AudioCodec | "disabled" | "error";
  width: number;
  height: number;
  /** encoder the server asked for, if any */
  videoEncoder?: string;
}

export interface SessionChange {
  width: number;
  height: number;
}

/** Query string for /ws/stream. All optional except serial. Server validates every field. */
export interface StreamQuery {
  serial: string;
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  audioSource?: AudioSource;
  /** "true" | "false" */
  audio?: string;
  maxSize?: string;
  bitrate?: string;
  maxFps?: string;
  displayId?: string;
  videoEncoder?: string;
  /** scrcpy key[:type]=value,... */
  videoCodecOptions?: string;
}

/** WebSocket close codes on /ws/stream and other endpoints. */
export const WsClose = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNSUPPORTED: 4002,
  BAD_REQUEST: 4003,
  SESSION_FAILED: 4005,
  UNAUTHORIZED: 4401,
} as const;
export const WS_CLOSE_REASON_MAX_BYTES = 123;

// ---------------------------------------------------------------- device list

export type DeviceState = "device" | "offline" | "unauthorized" | "authorizing" | "connecting";
export type DeviceKind = "phone" | "tablet" | "tv";
export type ScreenState = "awake" | "asleep" | "unknown";

export interface DeviceDescriptor {
  serial: string;
  state: DeviceState;
  /** true when serial looks like host:port */
  isNetwork: boolean;
  manufacturer?: string;
  model?: string;
  /** ro.build.version.release */
  androidVersion?: string;
  sdk?: number;
  kind?: DeviceKind;
  screen: ScreenState;
  /** resolved for the requesting user */
  label?: string;
}

export type DeviceListMessage =
  | { type: "devices"; devices: DeviceDescriptor[] }
  | { type: "device"; device: DeviceDescriptor }
  | { type: "removed"; serial: string }
  | { type: "adb"; ok: boolean; message?: string };

// ---------------------------------------------------------------- probe

export interface ProbeResult {
  width: number;
  height: number;
  density: number;
  sdk: number;
  videoEncoders: string[];
  audioEncoders: string[];
}

// ---------------------------------------------------------------- shell

export type ShellClientMessage =
  | { type: "start"; cols: number; rows: number }
  | { type: "resize"; cols: number; rows: number };
export type ShellServerMessage = { type: "exit"; code: number };

// ---------------------------------------------------------------- files

export interface FileEntry {
  name: string;
  /** POSIX mode bits */
  mode: number;
  size: number;
  /** unix seconds */
  mtime: number;
  isDir: boolean;
  isLink: boolean;
}

/** Text frames browser → server. `id` echoes back in every response for that request. */
export type FilesRequest =
  | { id: number; op: "list"; path: string }
  | { id: number; op: "stat"; path: string }
  | { id: number; op: "pull"; path: string }
  | { id: number; op: "push"; path: string; size: number }
  | { id: number; op: "cancel" };

/**
 * Text frames server → browser. For `pull`, data arrives as binary frames prefixed with the
 * u32 LE request id, then a `{done}` text frame. For `push`, the browser sends binary frames
 * prefixed with the u32 LE request id after `{ready}`, and ends with `{id, op:"push-end"}`.
 */
export type FilesResponse =
  | { id: number; type: "list"; entries: FileEntry[] }
  | { id: number; type: "stat"; entry: FileEntry }
  | { id: number; type: "ready" }
  | { id: number; type: "progress"; bytes: number }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };
export type FilesPushEnd = { id: number; op: "push-end" };
export const FILES_BINARY_PREFIX = 4;
export const FILES_CHUNK_SIZE = 64 * 1024;
