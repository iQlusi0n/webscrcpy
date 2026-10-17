import { describe, expect, test } from "bun:test";
import { DROP_TARGET_DIR, dropTargetPath } from "../../src/app/stream/dropPush.ts";
import { dpadKeyForWheel } from "../../src/app/stream/input/dpad.ts";
import { AndroidKey } from "../../src/app/stream/input/keycodes.ts";
import { mirrorPoint } from "../../src/app/stream/input/pointerState.ts";
import { textForKey } from "../../src/app/stream/input/text.ts";
import { mapToDevice, wheelToScroll } from "../../src/app/stream/input/touch.ts";
import {
  CODE_TO_HID_USAGE,
  DOM_BUTTON_TO_HID,
  KEYBOARD_DESCRIPTOR,
  keyboardReport,
  MOUSE_DESCRIPTOR,
  mouseReport,
} from "../../src/app/stream/input/uhid.ts";

describe("touch mapping", () => {
  const screen = { width: 1080, height: 1920 };

  test("maps inside a letterboxed element", () => {
    // 1080x1920 drawn inside 1000x1000 → scale 0.52083, drawn 562.5x1000, offset x 218.75
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(mapToDevice(218.75, 0, rect, screen)).toEqual({ x: 0, y: 0 });
    expect(mapToDevice(500, 500, rect, screen)).toEqual({ x: 540, y: 960 });
    expect(mapToDevice(100, 500, rect, screen)).toBeNull();
    expect(mapToDevice(781.25, 500, rect, screen)).toBeNull();
  });

  test("exact-fit element", () => {
    const rect = { left: 10, top: 20, width: 540, height: 960 };
    expect(mapToDevice(10, 20, rect, screen)).toEqual({ x: 0, y: 0 });
    expect(mapToDevice(549, 979, rect, screen)).toEqual({ x: 1078, y: 1918 });
    expect(mapToDevice(9, 20, rect, screen)).toBeNull();
  });

  test("wheel → scroll: divisor 128, clamped, wheel-down scrolls negative", () => {
    expect(wheelToScroll(0, 64)).toEqual({ hscroll: 0, vscroll: -0.5 });
    expect(wheelToScroll(-1000, -1000)).toEqual({ hscroll: -1, vscroll: 1 });
  });

  test("mirrorPoint reflects through the anchor", () => {
    expect(mirrorPoint({ x: 100, y: 100 }, { x: 540, y: 960 })).toEqual({ x: 980, y: 1820 });
    expect(mirrorPoint({ x: 1000, y: 0 }, { x: 100, y: 100 })).toEqual({ x: 0, y: 200 });
  });
});

describe("dpad wheel", () => {
  test("vertical and shifted horizontal", () => {
    expect(dpadKeyForWheel(0, 100, false)).toBe(AndroidKey.DPAD_DOWN);
    expect(dpadKeyForWheel(0, -100, false)).toBe(AndroidKey.DPAD_UP);
    expect(dpadKeyForWheel(0, 100, true)).toBe(AndroidKey.DPAD_RIGHT);
    expect(dpadKeyForWheel(0, -100, true)).toBe(AndroidKey.DPAD_LEFT);
    expect(dpadKeyForWheel(0, 0, false)).toBeNull();
  });
});

describe("text vs keycode path", () => {
  const ev = (code: string, key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ code, key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  test("US-layout characters stay on the keycode path", () => {
    expect(textForKey(ev("KeyA", "a"))).toBeNull();
    expect(textForKey(ev("Digit1", "!", { shiftKey: true }))).toBeNull();
    expect(textForKey(ev("Enter", "Enter"))).toBeNull();
  });
  test("layout-dependent and non-ASCII characters become text", () => {
    expect(textForKey(ev("KeyQ", "a"))).toBe("a"); // AZERTY
    expect(textForKey(ev("Digit2", "é"))).toBe("é");
    expect(textForKey(ev("BracketLeft", "ü"))).toBe("ü");
  });
  test("shortcuts never become text", () => {
    expect(textForKey(ev("KeyQ", "a", { ctrlKey: true }))).toBeNull();
  });
  test("AltGr characters (Ctrl+Alt on Windows) become text", () => {
    const altGr = { ctrlKey: true, altKey: true, getModifierState: (m: string) => m === "AltGraph" };
    expect(textForKey(ev("KeyQ", "@", altGr))).toBe("@");
    expect(textForKey(ev("KeyE", "€", altGr))).toBe("€");
  });
});

describe("UHID reports", () => {
  test("descriptors have the boot-protocol sizes", () => {
    expect(KEYBOARD_DESCRIPTOR.length).toBe(63);
    expect(MOUSE_DESCRIPTOR[0]).toBe(0x05);
    expect(MOUSE_DESCRIPTOR[MOUSE_DESCRIPTOR.length - 1]).toBe(0xc0);
  });
  test("keyboard report is 8 bytes, 6KRO", () => {
    expect(Array.from(keyboardReport(0x02, [4, 5, 6, 7, 8, 9, 10]))).toEqual([2, 0, 4, 5, 6, 7, 8, 9]);
  });
  test("mouse report clamps deltas to int8", () => {
    expect(Array.from(mouseReport(1, 300, -300, -1))).toEqual([1, 127, 0x81, 0xff]);
  });
  test("DOM buttons map to HID bits: left, right, middle, back, forward", () => {
    expect([0, 1, 2, 3, 4].map((b) => DOM_BUTTON_TO_HID[b])).toEqual([0x01, 0x04, 0x02, 0x08, 0x10]);
  });
  test("keyboard descriptor's usage range covers every mapped usage", () => {
    // key array: Logical Maximum at [52..53], Usage Maximum at [58..59]
    const logicalMax = KEYBOARD_DESCRIPTOR[53] ?? 0;
    const usageMax = KEYBOARD_DESCRIPTOR[59] ?? 0;
    const highest = Math.max(...Object.values(CODE_TO_HID_USAGE));
    expect(highest).toBeGreaterThan(0x65);
    expect(logicalMax).toBeGreaterThanOrEqual(highest);
    expect(usageMax).toBeGreaterThanOrEqual(highest);
  });
});

describe("drop push target path", () => {
  test("uses the basename under the Download directory", () => {
    expect(dropTargetPath("photo.jpg")).toBe(`${DROP_TARGET_DIR}/photo.jpg`);
    expect(dropTargetPath("../../etc/passwd")).toBe(`${DROP_TARGET_DIR}/passwd`);
    expect(dropTargetPath("C:\\Users\\x\\a.txt")).toBe(`${DROP_TARGET_DIR}/a.txt`);
    expect(dropTargetPath("..")).toBe(`${DROP_TARGET_DIR}/dropped-file`);
    expect(dropTargetPath("")).toBe(`${DROP_TARGET_DIR}/dropped-file`);
  });
});
