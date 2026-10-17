/**
 * Contract between the stream engine (src/app/stream/*) and the UI (src/app/ui/*).
 * `startStream` mounts a complete stream view (toolbar + canvas + overlays) into `container`.
 */
import type { DeviceStreamSettings } from "@common/api.ts";
import type { DeviceKind, StreamMetadata } from "@common/protocol.ts";

export interface StreamOptions {
  serial: string;
  settings: DeviceStreamSettings;
  container: HTMLElement;
  deviceKind?: DeviceKind;
  /** seeds the D-pad/Touch default; default: touch unless deviceKind === 'tv' */
  dpadMode?: boolean;
  onConnect?(meta: StreamMetadata): void;
  /** normal end: stop() or server close 1000/1001/1005 */
  onDisconnect?(reason?: string): void;
  /** abnormal end or startup failure; exactly one of onDisconnect/onError fires */
  onError?(err: Error): void;
}

export interface StreamStats {
  resolution: string;
  codec: string;
  encoder?: string;
  inputFps: number;
  decodedFps: number;
  droppedFps: number;
  bytesPerSecond: number;
}

export interface StreamHandle {
  readonly serial: string;
  readonly isConnected: boolean;
  readonly metadata: StreamMetadata | null;
  stop(): void;
  /** reconnect with the same settings */
  refresh(): void;
  setDpadMode(enabled: boolean): void;
  setCaptureKeyboard(enabled: boolean): void;
  setUhid(enabled: boolean): void;
  setShowStats(enabled: boolean): void;
  /** triggers a browser download of the current frame as PNG */
  screenshot(): void;
  getStats(): StreamStats;
}

export type StartStream = (opts: StreamOptions) => StreamHandle;
