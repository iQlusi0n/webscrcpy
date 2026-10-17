/**
 * Control message encoders (client → device), byte-exact per SCRCPY_PROTOCOL.md §4.
 * Pure functions over Uint8Array; no DOM, no state.
 */
import {
  ControlMsg,
  CONTROL_MSG_MAX_SIZE,
  INJECT_TEXT_MAX_LENGTH,
  floatToI16FP,
  floatToU16FP,
} from "@common/scrcpy.ts";

const textEncoder = new TextEncoder();

class ByteWriter {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(v: number): this {
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.view.setUint16(this.pos, v);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.view.setInt16(this.pos, v);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
    return this;
  }
  u64(v: bigint): this {
    this.view.setBigUint64(this.pos, BigInt.asUintN(64, v));
    this.pos += 8;
    return this;
  }
  raw(b: Uint8Array): this {
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
}

/** UTF-8 encode and truncate to `maxBytes` without splitting a code point. */
export function encodeUtf8Bounded(text: string, maxBytes: number): Uint8Array {
  const full = textEncoder.encode(text);
  if (full.length <= maxBytes) return full;
  let end = maxBytes;
  while (end > 0 && (full[end]! & 0xc0) === 0x80) end--;
  return full.subarray(0, end);
}

export interface TouchEvent {
  action: number;
  pointerId: bigint;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  /** [0,1] */
  pressure: number;
  actionButton: number;
  buttons: number;
}

export interface ScrollEvent {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  /** [-1,1] */
  hscroll: number;
  /** [-1,1] */
  vscroll: number;
  buttons: number;
}

export function injectKeycode(action: number, keycode: number, repeat: number, metastate: number): Uint8Array {
  return new ByteWriter(14).u8(ControlMsg.INJECT_KEYCODE).u8(action).u32(keycode).u32(repeat).u32(metastate).bytes;
}

export function injectText(text: string): Uint8Array {
  const utf8 = encodeUtf8Bounded(text, INJECT_TEXT_MAX_LENGTH);
  return new ByteWriter(5 + utf8.length).u8(ControlMsg.INJECT_TEXT).u32(utf8.length).raw(utf8).bytes;
}

export function injectTouch(e: TouchEvent): Uint8Array {
  return new ByteWriter(32)
    .u8(ControlMsg.INJECT_TOUCH_EVENT)
    .u8(e.action)
    .u64(e.pointerId)
    .u32(e.x)
    .u32(e.y)
    .u16(e.screenWidth)
    .u16(e.screenHeight)
    .u16(floatToU16FP(e.pressure))
    .u32(e.actionButton)
    .u32(e.buttons).bytes;
}

export function injectScroll(e: ScrollEvent): Uint8Array {
  return new ByteWriter(21)
    .u8(ControlMsg.INJECT_SCROLL_EVENT)
    .u32(e.x)
    .u32(e.y)
    .u16(e.screenWidth)
    .u16(e.screenHeight)
    .i16(floatToI16FP(e.hscroll))
    .i16(floatToI16FP(e.vscroll))
    .u32(e.buttons).bytes;
}

export function backOrScreenOn(action: number): Uint8Array {
  return new ByteWriter(2).u8(ControlMsg.BACK_OR_SCREEN_ON).u8(action).bytes;
}

export function expandNotificationPanel(): Uint8Array {
  return Uint8Array.of(ControlMsg.EXPAND_NOTIFICATION_PANEL);
}

export function expandSettingsPanel(): Uint8Array {
  return Uint8Array.of(ControlMsg.EXPAND_SETTINGS_PANEL);
}

export function collapsePanels(): Uint8Array {
  return Uint8Array.of(ControlMsg.COLLAPSE_PANELS);
}

export function getClipboard(copyKey: number): Uint8Array {
  return new ByteWriter(2).u8(ControlMsg.GET_CLIPBOARD).u8(copyKey).bytes;
}

export function setClipboard(sequence: bigint, paste: boolean, text: string): Uint8Array {
  const utf8 = encodeUtf8Bounded(text, CONTROL_MSG_MAX_SIZE - 14);
  return new ByteWriter(14 + utf8.length)
    .u8(ControlMsg.SET_CLIPBOARD)
    .u64(sequence)
    .u8(paste ? 1 : 0)
    .u32(utf8.length)
    .raw(utf8).bytes;
}

export function setDisplayPower(on: boolean): Uint8Array {
  return new ByteWriter(2).u8(ControlMsg.SET_DISPLAY_POWER).u8(on ? 1 : 0).bytes;
}

export function rotateDevice(): Uint8Array {
  return Uint8Array.of(ControlMsg.ROTATE_DEVICE);
}

export function uhidCreate(
  id: number,
  vendorId: number,
  productId: number,
  name: string,
  descriptor: Uint8Array,
): Uint8Array {
  const utf8 = encodeUtf8Bounded(name, 127);
  return new ByteWriter(10 + utf8.length + descriptor.length)
    .u8(ControlMsg.UHID_CREATE)
    .u16(id)
    .u16(vendorId)
    .u16(productId)
    .u8(utf8.length)
    .raw(utf8)
    .u16(descriptor.length)
    .raw(descriptor).bytes;
}

export function uhidInput(id: number, report: Uint8Array): Uint8Array {
  return new ByteWriter(5 + report.length).u8(ControlMsg.UHID_INPUT).u16(id).u16(report.length).raw(report).bytes;
}

export function uhidDestroy(id: number): Uint8Array {
  return new ByteWriter(3).u8(ControlMsg.UHID_DESTROY).u16(id).bytes;
}

export function openHardKeyboardSettings(): Uint8Array {
  return Uint8Array.of(ControlMsg.OPEN_HARD_KEYBOARD_SETTINGS);
}

export function startApp(name: string): Uint8Array {
  const utf8 = encodeUtf8Bounded(name, 255);
  return new ByteWriter(2 + utf8.length).u8(ControlMsg.START_APP).u8(utf8.length).raw(utf8).bytes;
}

export function resetVideo(): Uint8Array {
  return Uint8Array.of(ControlMsg.RESET_VIDEO);
}

export function cameraSetTorch(on: boolean): Uint8Array {
  return new ByteWriter(2).u8(ControlMsg.CAMERA_SET_TORCH).u8(on ? 1 : 0).bytes;
}

export function cameraZoomIn(): Uint8Array {
  return Uint8Array.of(ControlMsg.CAMERA_ZOOM_IN);
}

export function cameraZoomOut(): Uint8Array {
  return Uint8Array.of(ControlMsg.CAMERA_ZOOM_OUT);
}

export function resizeDisplay(width: number, height: number): Uint8Array {
  return new ByteWriter(5).u8(ControlMsg.RESIZE_DISPLAY).u16(width).u16(height).bytes;
}

export function scanFile(path: string): Uint8Array {
  const utf8 = encodeUtf8Bounded(path, 256);
  return new ByteWriter(5 + utf8.length).u8(ControlMsg.SCAN_FILE).u32(utf8.length).raw(utf8).bytes;
}
