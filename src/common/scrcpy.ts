/**
 * scrcpy-server v5.0 wire constants. Derived from Genymobile/scrcpy (Apache-2.0):
 * app/src/control_msg.h, app/src/device_msg.h, server/.../Streamer.java.
 * See SCRCPY_PROTOCOL.md for the full reference. Pure module: browser + Bun.
 */

export const SCRCPY_VERSION = "5.0";
export const SCRCPY_SERVER_CLASS = "com.genymobile.scrcpy.Server";
export const SCRCPY_DEVICE_PATH = "/data/local/tmp/scrcpy-server.jar";

export const DEVICE_NAME_FIELD_LENGTH = 64;

/** 12-byte header on every media packet: u64 ptsAndFlags, u32 size. */
export const FRAME_HEADER_SIZE = 12;
export const PTS_FLAG_SESSION = 1n << 63n;
export const PTS_FLAG_CONFIG = 1n << 62n;
export const PTS_FLAG_KEYFRAME = 1n << 61n;
export const PTS_MASK = (1n << 61n) - 1n;

export type VideoCodec = "h264" | "h265" | "av1" | "vp8" | "vp9";
export type AudioCodec = "opus" | "aac" | "flac" | "raw";
export type AudioSource = "output" | "mic" | "playback";

/** FourCC codec ids as written on the wire (SCRCPY_PROTOCOL.md §3.1); hex keeps the ASCII visible. */
// biome-ignore-start lint/complexity/useSimpleNumberKeys: hex FourCC values are the spec
export const VIDEO_CODEC_IDS: Record<number, VideoCodec> = {
  0x68323634: "h264",
  0x68323635: "h265",
  0x00617631: "av1",
  0x00767038: "vp8",
  0x00767039: "vp9",
};
export const AUDIO_CODEC_IDS: Record<number, AudioCodec> = {
  0x6f707573: "opus",
  0x00616163: "aac",
  0x666c6163: "flac",
  0x00726177: "raw",
};
// biome-ignore-end lint/complexity/useSimpleNumberKeys: hex FourCC values are the spec
/** Audio socket may open with one of these instead of a codec id. */
export const AUDIO_DISABLED = 0x00000000;
export const AUDIO_ERROR = 0x00000001;

/** Client → device control message types (control_msg.h, 5.0). */
export const ControlMsg = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
} as const;

export const CopyKey = { NONE: 0, COPY: 1, CUT: 2 } as const;

/** Device → client message types (device_msg.h). Unknown type = unrecoverable desync. */
export const DeviceMsg = {
  CLIPBOARD: 0,
  ACK_CLIPBOARD: 1,
  UHID_OUTPUT: 2,
} as const;

export const CONTROL_MSG_MAX_SIZE = 1 << 18;
export const INJECT_TEXT_MAX_LENGTH = 300;

/** Android MotionEvent / KeyEvent constants used on the wire. */
export const MotionAction = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
} as const;
export const KeyAction = { DOWN: 0, UP: 1 } as const;
export const MotionButton = { PRIMARY: 1, SECONDARY: 2, TERTIARY: 4, BACK: 8, FORWARD: 16 } as const;
export const POINTER_ID_MOUSE = 0xffffffffffffffffn;
export const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen;
export const POINTER_ID_VIRTUAL_FINGER = 0xfffffffffffffffdn;

/** f ∈ [0,1] → u16 fixed point (pressure). */
export function floatToU16FP(f: number): number {
  const u = Math.floor(Math.max(0, Math.min(1, f)) * 0x10000);
  return u >= 0xffff ? 0xffff : u;
}
/** f ∈ [-1,1] → i16 fixed point (scroll). */
export function floatToI16FP(f: number): number {
  const i = Math.trunc(Math.max(-1, Math.min(1, f)) * 0x8000);
  return i >= 0x7fff ? 0x7fff : i;
}
