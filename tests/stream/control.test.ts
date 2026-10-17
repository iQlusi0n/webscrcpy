import { describe, expect, test } from "bun:test";
import { floatToI16FP, floatToU16FP, MotionAction, MotionButton, POINTER_ID_MOUSE } from "@common/scrcpy.ts";
import {
  backOrScreenOn,
  getClipboard,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  resetVideo,
  resizeDisplay,
  setClipboard,
  setDisplayPower,
  startApp,
  uhidCreate,
  uhidDestroy,
  uhidInput,
} from "../../src/app/stream/control.ts";

const bytes = (...v: number[]): Uint8Array => Uint8Array.of(...v);

describe("fixed-point helpers", () => {
  test("u16fp maps [0,1] with saturation", () => {
    expect(floatToU16FP(0)).toBe(0);
    expect(floatToU16FP(0.5)).toBe(0x8000);
    expect(floatToU16FP(1)).toBe(0xffff);
    expect(floatToU16FP(2)).toBe(0xffff);
  });
  test("i16fp maps [-1,1] with saturation", () => {
    expect(floatToI16FP(0)).toBe(0);
    expect(floatToI16FP(-1)).toBe(-0x8000);
    expect(floatToI16FP(0.5)).toBe(0x4000);
    expect(floatToI16FP(1)).toBe(0x7fff);
  });
});

describe("control encoders (SCRCPY_PROTOCOL.md §4)", () => {
  test("INJECT_KEYCODE is 14 bytes", () => {
    expect(injectKeycode(1, 4, 2, 0x1001)).toEqual(bytes(0, 1, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0x10, 0x01));
  });

  test("INJECT_TEXT prefixes a u32 length and truncates at 300 UTF-8 bytes", () => {
    expect(injectText("hé")).toEqual(bytes(1, 0, 0, 0, 3, 0x68, 0xc3, 0xa9));
    const long = injectText("é".repeat(200));
    expect(long.length).toBe(5 + 300);
    expect(new DataView(long.buffer).getUint32(1)).toBe(300);
  });

  test("INJECT_TOUCH_EVENT is 32 bytes with u16fp pressure", () => {
    const msg = injectTouch({
      action: MotionAction.DOWN,
      pointerId: POINTER_ID_MOUSE,
      x: 100,
      y: 200,
      screenWidth: 1080,
      screenHeight: 1920,
      pressure: 1,
      actionButton: MotionButton.PRIMARY,
      buttons: MotionButton.PRIMARY,
    });
    expect(msg).toEqual(
      bytes(
        2, 0,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0, 0, 0, 100,
        0, 0, 0, 200,
        0x04, 0x38,
        0x07, 0x80,
        0xff, 0xff,
        0, 0, 0, 1,
        0, 0, 0, 1,
      ),
    );
  });

  test("INJECT_SCROLL_EVENT is 21 bytes with i16fp amounts", () => {
    const msg = injectScroll({ x: 1, y: 2, screenWidth: 3, screenHeight: 4, hscroll: -1, vscroll: 0.5, buttons: 0 });
    expect(msg).toEqual(bytes(3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 3, 0, 4, 0x80, 0x00, 0x40, 0x00, 0, 0, 0, 0));
  });

  test("single-byte payload messages", () => {
    expect(backOrScreenOn(1)).toEqual(bytes(4, 1));
    expect(getClipboard(1)).toEqual(bytes(8, 1));
    expect(setDisplayPower(true)).toEqual(bytes(10, 1));
    expect(resetVideo()).toEqual(bytes(17));
  });

  test("SET_CLIPBOARD carries sequence, paste flag and length", () => {
    expect(setClipboard(0x0102n, true, "ab")).toEqual(bytes(9, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 2, 0x61, 0x62));
  });

  test("UHID create/input/destroy", () => {
    expect(uhidCreate(1, 0x1234, 0x5678, "kb", bytes(0xaa, 0xbb))).toEqual(
      bytes(12, 0, 1, 0x12, 0x34, 0x56, 0x78, 2, 0x6b, 0x62, 0, 2, 0xaa, 0xbb),
    );
    expect(uhidInput(2, bytes(1, 2, 3, 4))).toEqual(bytes(13, 0, 2, 0, 4, 1, 2, 3, 4));
    expect(uhidDestroy(1)).toEqual(bytes(14, 0, 1));
  });

  test("START_APP and RESIZE_DISPLAY", () => {
    expect(startApp("x")).toEqual(bytes(16, 1, 0x78));
    expect(resizeDisplay(1080, 1920)).toEqual(bytes(21, 0x04, 0x38, 0x07, 0x80));
  });
});
