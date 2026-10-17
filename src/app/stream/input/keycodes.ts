/** Android KeyEvent constants and the KeyboardEvent.code → KEYCODE_* table. Pure module. */

export const AndroidKey = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  APP_SWITCH: 187,
} as const;

/** KeyEvent.META_* bits. */
export const MetaState = {
  SHIFT_ON: 0x1,
  ALT_ON: 0x2,
  SYM_ON: 0x4,
  ALT_LEFT_ON: 0x10,
  ALT_RIGHT_ON: 0x20,
  SHIFT_LEFT_ON: 0x40,
  SHIFT_RIGHT_ON: 0x80,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  CTRL_RIGHT_ON: 0x4000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x20000,
  META_RIGHT_ON: 0x40000,
  CAPS_LOCK_ON: 0x100000,
  NUM_LOCK_ON: 0x200000,
  SCROLL_LOCK_ON: 0x400000,
} as const;

/** KeyboardEvent.code → Android keycode. */
export const CODE_TO_KEYCODE: Record<string, number> = {
  KeyA: 29, KeyB: 30, KeyC: 31, KeyD: 32, KeyE: 33, KeyF: 34, KeyG: 35, KeyH: 36, KeyI: 37, KeyJ: 38,
  KeyK: 39, KeyL: 40, KeyM: 41, KeyN: 42, KeyO: 43, KeyP: 44, KeyQ: 45, KeyR: 46, KeyS: 47, KeyT: 48,
  KeyU: 49, KeyV: 50, KeyW: 51, KeyX: 52, KeyY: 53, KeyZ: 54,
  Digit0: 7, Digit1: 8, Digit2: 9, Digit3: 10, Digit4: 11, Digit5: 12, Digit6: 13, Digit7: 14, Digit8: 15, Digit9: 16,
  Comma: 55, Period: 56, Space: 62, Enter: 66, Backspace: 67, Backquote: 68, Minus: 69, Equal: 70,
  BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75, Slash: 76,
  Tab: 61, Escape: 111, Delete: 112, CapsLock: 115, ScrollLock: 116, PrintScreen: 120, Pause: 121,
  Home: 122, End: 123, Insert: 124, PageUp: 92, PageDown: 93,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  AltLeft: 57, AltRight: 58, ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114,
  MetaLeft: 117, MetaRight: 118, ContextMenu: 82,
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
  NumLock: 143, Numpad0: 144, Numpad1: 145, Numpad2: 146, Numpad3: 147, Numpad4: 148, Numpad5: 149,
  Numpad6: 150, Numpad7: 151, Numpad8: 152, Numpad9: 153, NumpadDivide: 154, NumpadMultiply: 155,
  NumpadSubtract: 156, NumpadAdd: 157, NumpadDecimal: 158, NumpadComma: 159, NumpadEnter: 160, NumpadEqual: 161,
  NumpadParenLeft: 162, NumpadParenRight: 163,
  AudioVolumeUp: 24, AudioVolumeDown: 25, AudioVolumeMute: 164, MediaPlayPause: 85, MediaStop: 86,
  MediaTrackNext: 87, MediaTrackPrevious: 88, BrowserSearch: 84, BrowserHome: 3, BrowserBack: 4, BrowserForward: 125,
  Power: 26, Sleep: 223, WakeUp: 224,
  IntlRo: 217, IntlYen: 216, KanaMode: 218, Convert: 214, NonConvert: 213, Lang1: 218, Lang2: 212,
};

/**
 * Characters a US layout produces for each printable code, [unshifted, shifted]. A keydown whose
 * `key` matches one of these is expressible as a keycode (+META_SHIFT); anything else needs
 * INJECT_TEXT.
 */
export const US_LAYOUT_CHARS: Record<string, readonly [string, string]> = {
  KeyA: ["a", "A"], KeyB: ["b", "B"], KeyC: ["c", "C"], KeyD: ["d", "D"], KeyE: ["e", "E"], KeyF: ["f", "F"],
  KeyG: ["g", "G"], KeyH: ["h", "H"], KeyI: ["i", "I"], KeyJ: ["j", "J"], KeyK: ["k", "K"], KeyL: ["l", "L"],
  KeyM: ["m", "M"], KeyN: ["n", "N"], KeyO: ["o", "O"], KeyP: ["p", "P"], KeyQ: ["q", "Q"], KeyR: ["r", "R"],
  KeyS: ["s", "S"], KeyT: ["t", "T"], KeyU: ["u", "U"], KeyV: ["v", "V"], KeyW: ["w", "W"], KeyX: ["x", "X"],
  KeyY: ["y", "Y"], KeyZ: ["z", "Z"],
  Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"], Digit5: ["5", "%"],
  Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("], Digit0: ["0", ")"],
  Backquote: ["`", "~"], Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
  Backslash: ["\\", "|"], Semicolon: [";", ":"], Quote: ["'", '"'], Comma: [",", "<"], Period: [".", ">"],
  Slash: ["/", "?"], Space: [" ", " "],
  Numpad0: ["0", "0"], Numpad1: ["1", "1"], Numpad2: ["2", "2"], Numpad3: ["3", "3"], Numpad4: ["4", "4"],
  Numpad5: ["5", "5"], Numpad6: ["6", "6"], Numpad7: ["7", "7"], Numpad8: ["8", "8"], Numpad9: ["9", "9"],
  NumpadDivide: ["/", "/"], NumpadMultiply: ["*", "*"], NumpadSubtract: ["-", "-"], NumpadAdd: ["+", "+"],
  NumpadDecimal: [".", "."], NumpadEqual: ["=", "="],
};

/** Modifier bits from a KeyboardEvent, Android-style (generic + side-specific flags). */
export function metaStateOf(e: KeyboardEvent): number {
  let meta = 0;
  if (e.shiftKey) meta |= MetaState.SHIFT_ON | (e.code === "ShiftRight" ? MetaState.SHIFT_RIGHT_ON : MetaState.SHIFT_LEFT_ON);
  if (e.ctrlKey) meta |= MetaState.CTRL_ON | (e.code === "ControlRight" ? MetaState.CTRL_RIGHT_ON : MetaState.CTRL_LEFT_ON);
  if (e.altKey) meta |= MetaState.ALT_ON | (e.code === "AltRight" ? MetaState.ALT_RIGHT_ON : MetaState.ALT_LEFT_ON);
  if (e.metaKey) meta |= MetaState.META_ON | (e.code === "MetaRight" ? MetaState.META_RIGHT_ON : MetaState.META_LEFT_ON);
  if (e.getModifierState("CapsLock")) meta |= MetaState.CAPS_LOCK_ON;
  if (e.getModifierState("NumLock")) meta |= MetaState.NUM_LOCK_ON;
  if (e.getModifierState("ScrollLock")) meta |= MetaState.SCROLL_LOCK_ON;
  return meta;
}
