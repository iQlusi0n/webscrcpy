/**
 * UHID keyboard (id 1, boot protocol, 6KRO) and relative mouse (id 2, 5 buttons + x/y/wheel) over
 * UHID_CREATE/INPUT/DESTROY. Keyboard listens on the document; the mouse uses Pointer Lock on
 * the canvas. While enabled, the touch and keycode paths must be detached by the caller.
 */
import { uhidCreate, uhidDestroy, uhidInput } from "../control.ts";
import { isTextEntry, type SendControl } from "./text.ts";

export const UHID_KEYBOARD_ID = 1;
export const UHID_MOUSE_ID = 2;

/** USB HID boot-protocol keyboard report descriptor (63 bytes). */
export const KEYBOARD_DESCRIPTOR = Uint8Array.of(
  0x05,
  0x01,
  0x09,
  0x06,
  0xa1,
  0x01,
  0x05,
  0x07,
  0x19,
  0xe0,
  0x29,
  0xe7,
  0x15,
  0x00,
  0x25,
  0x01,
  0x75,
  0x01,
  0x95,
  0x08,
  0x81,
  0x02,
  0x95,
  0x01,
  0x75,
  0x08,
  0x81,
  0x01,
  0x95,
  0x05,
  0x75,
  0x01,
  0x05,
  0x08,
  0x19,
  0x01,
  0x29,
  0x05,
  0x91,
  0x02,
  0x95,
  0x01,
  0x75,
  0x03,
  0x91,
  0x01,
  0x95,
  0x06,
  0x75,
  0x08,
  0x15,
  0x00,
  0x25,
  0x65,
  0x05,
  0x07,
  0x19,
  0x00,
  0x29,
  0x65,
  0x81,
  0x00,
  0xc0,
);

/** Relative mouse: 5 buttons, int8 x/y/wheel. */
export const MOUSE_DESCRIPTOR = Uint8Array.of(
  0x05,
  0x01,
  0x09,
  0x02,
  0xa1,
  0x01,
  0x09,
  0x01,
  0xa1,
  0x00,
  0x05,
  0x09,
  0x19,
  0x01,
  0x29,
  0x05,
  0x15,
  0x00,
  0x25,
  0x01,
  0x95,
  0x05,
  0x75,
  0x01,
  0x81,
  0x02,
  0x95,
  0x01,
  0x75,
  0x03,
  0x81,
  0x01,
  0x05,
  0x01,
  0x09,
  0x30,
  0x09,
  0x31,
  0x15,
  0x81,
  0x25,
  0x7f,
  0x75,
  0x08,
  0x95,
  0x02,
  0x81,
  0x06,
  0x09,
  0x38,
  0x15,
  0x81,
  0x25,
  0x7f,
  0x75,
  0x08,
  0x95,
  0x01,
  0x81,
  0x06,
  0xc0,
  0xc0,
);

/** KeyboardEvent.code → HID keyboard usage (page 0x07). */
export const CODE_TO_HID_USAGE: Record<string, number> = {
  KeyA: 4,
  KeyB: 5,
  KeyC: 6,
  KeyD: 7,
  KeyE: 8,
  KeyF: 9,
  KeyG: 10,
  KeyH: 11,
  KeyI: 12,
  KeyJ: 13,
  KeyK: 14,
  KeyL: 15,
  KeyM: 16,
  KeyN: 17,
  KeyO: 18,
  KeyP: 19,
  KeyQ: 20,
  KeyR: 21,
  KeyS: 22,
  KeyT: 23,
  KeyU: 24,
  KeyV: 25,
  KeyW: 26,
  KeyX: 27,
  KeyY: 28,
  KeyZ: 29,
  Digit1: 30,
  Digit2: 31,
  Digit3: 32,
  Digit4: 33,
  Digit5: 34,
  Digit6: 35,
  Digit7: 36,
  Digit8: 37,
  Digit9: 38,
  Digit0: 39,
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  F1: 58,
  F2: 59,
  F3: 60,
  F4: 61,
  F5: 62,
  F6: 63,
  F7: 64,
  F8: 65,
  F9: 66,
  F10: 67,
  F11: 68,
  F12: 69,
  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  NumLock: 83,
  NumpadDivide: 84,
  NumpadMultiply: 85,
  NumpadSubtract: 86,
  NumpadAdd: 87,
  NumpadEnter: 88,
  Numpad1: 89,
  Numpad2: 90,
  Numpad3: 91,
  Numpad4: 92,
  Numpad5: 93,
  Numpad6: 94,
  Numpad7: 95,
  Numpad8: 96,
  Numpad9: 97,
  Numpad0: 98,
  NumpadDecimal: 99,
  IntlBackslash: 100,
  ContextMenu: 101,
  Power: 102,
  NumpadEqual: 103,
  F13: 104,
  F14: 105,
  F15: 106,
  F16: 107,
  F17: 108,
  F18: 109,
  F19: 110,
  F20: 111,
  F21: 112,
  F22: 113,
  F23: 114,
  F24: 115,
  IntlRo: 135,
  KanaMode: 136,
  IntlYen: 137,
  Convert: 138,
  NonConvert: 139,
};

export const CODE_TO_HID_MODIFIER: Record<string, number> = {
  ControlLeft: 0x01,
  ShiftLeft: 0x02,
  AltLeft: 0x04,
  MetaLeft: 0x08,
  ControlRight: 0x10,
  ShiftRight: 0x20,
  AltRight: 0x40,
  MetaRight: 0x80,
};

/** 8-byte boot keyboard report: [modifiers, reserved, up to 6 usages]. Exported for tests. */
export function keyboardReport(modifiers: number, pressed: Iterable<number>): Uint8Array {
  const report = new Uint8Array(8);
  report[0] = modifiers;
  let i = 2;
  for (const usage of pressed) {
    if (i >= 8) break;
    report[i++] = usage;
  }
  return report;
}

/** 4-byte mouse report: [buttons, dx, dy, wheel] with int8 deltas clamped to ±127. */
export function mouseReport(buttons: number, dx: number, dy: number, wheel: number): Uint8Array {
  const clamp = (v: number): number => Math.max(-127, Math.min(127, Math.trunc(v))) & 0xff;
  return Uint8Array.of(buttons & 0x1f, clamp(dx), clamp(dy), clamp(wheel));
}

export class UhidInput {
  private enabled = false;
  private modifiers = 0;
  private readonly pressed = new Set<number>();
  private mouseButtons = 0;

  constructor(
    private readonly send: SendControl,
    private readonly canvas: HTMLElement,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.send(uhidCreate(UHID_KEYBOARD_ID, 0, 0, "webscrcpy keyboard", KEYBOARD_DESCRIPTOR));
      this.send(uhidCreate(UHID_MOUSE_ID, 0, 0, "webscrcpy mouse", MOUSE_DESCRIPTOR));
      document.addEventListener("keydown", this.onKeyDown);
      document.addEventListener("keyup", this.onKeyUp);
      window.addEventListener("blur", this.onBlur);
      this.canvas.addEventListener("click", this.onCanvasClick);
      document.addEventListener("pointerlockchange", this.onLockChange);
    } else {
      document.removeEventListener("keydown", this.onKeyDown);
      document.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("blur", this.onBlur);
      this.canvas.removeEventListener("click", this.onCanvasClick);
      document.removeEventListener("pointerlockchange", this.onLockChange);
      this.detachMouse();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.modifiers = 0;
      this.pressed.clear();
      this.mouseButtons = 0;
      this.send(uhidInput(UHID_KEYBOARD_ID, keyboardReport(0, [])));
      this.send(uhidInput(UHID_MOUSE_ID, mouseReport(0, 0, 0, 0)));
      this.send(uhidDestroy(UHID_KEYBOARD_ID));
      this.send(uhidDestroy(UHID_MOUSE_ID));
    }
  }

  destroy(): void {
    this.setEnabled(false);
  }

  // ---------------------------------------------------------------- keyboard

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(document.activeElement)) return;
    e.preventDefault();
    const mod = CODE_TO_HID_MODIFIER[e.code];
    if (mod !== undefined) {
      this.modifiers |= mod;
      this.sendKeyboard();
      return;
    }
    const usage = CODE_TO_HID_USAGE[e.code];
    if (usage === undefined || this.pressed.has(usage)) return;
    this.pressed.add(usage);
    this.sendKeyboard();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (isTextEntry(document.activeElement)) return;
    e.preventDefault();
    const mod = CODE_TO_HID_MODIFIER[e.code];
    if (mod !== undefined) {
      this.modifiers &= ~mod;
      this.sendKeyboard();
      return;
    }
    const usage = CODE_TO_HID_USAGE[e.code];
    if (usage === undefined || !this.pressed.delete(usage)) return;
    this.sendKeyboard();
  };

  private readonly onBlur = (): void => {
    if (this.modifiers === 0 && this.pressed.size === 0) return;
    this.modifiers = 0;
    this.pressed.clear();
    this.sendKeyboard();
  };

  private sendKeyboard(): void {
    this.send(uhidInput(UHID_KEYBOARD_ID, keyboardReport(this.modifiers, this.pressed)));
  }

  // ---------------------------------------------------------------- mouse

  private readonly onCanvasClick = (): void => {
    if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock();
  };

  private readonly onLockChange = (): void => {
    if (document.pointerLockElement === this.canvas) {
      this.attachMouse();
    } else {
      this.detachMouse();
      if (this.mouseButtons !== 0) {
        this.mouseButtons = 0;
        this.send(uhidInput(UHID_MOUSE_ID, mouseReport(0, 0, 0, 0)));
      }
    }
  };

  private attachMouse(): void {
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("contextmenu", this.onContextMenu);
  }

  private detachMouse(): void {
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("contextmenu", this.onContextMenu);
  }

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (e.movementX === 0 && e.movementY === 0) return;
    this.send(uhidInput(UHID_MOUSE_ID, mouseReport(this.mouseButtons, e.movementX, e.movementY, 0)));
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.mouseButtons |= 1 << e.button;
    this.send(uhidInput(UHID_MOUSE_ID, mouseReport(this.mouseButtons, 0, 0, 0)));
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    e.preventDefault();
    this.mouseButtons &= ~(1 << e.button);
    this.send(uhidInput(UHID_MOUSE_ID, mouseReport(this.mouseButtons, 0, 0, 0)));
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const wheel = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
    if (wheel === 0) return;
    this.send(uhidInput(UHID_MOUSE_ID, mouseReport(this.mouseButtons, 0, 0, wheel)));
  };
}
