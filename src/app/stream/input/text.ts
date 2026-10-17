/**
 * INJECT_TEXT path for characters the keycode table cannot express (non-ASCII, layout-shifted
 * symbols) and a paste helper that chunks long text under the 300-byte message limit.
 */
import { INJECT_TEXT_MAX_LENGTH } from "@common/scrcpy.ts";
import { injectText } from "../control.ts";
import { CODE_TO_KEYCODE, US_LAYOUT_CHARS } from "./keycodes.ts";

export type SendControl = (bytes: Uint8Array) => void;

/**
 * The single printable character this keydown should be injected as text, or null when the
 * keycode path handles it (shortcuts with Ctrl/Alt/Meta, US-layout characters, non-printables).
 */
export function textForKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = e.key;
  if ([...key].length !== 1) return null;
  if (key === " " || key === "\n" || key === "\t") return null;
  const chars = US_LAYOUT_CHARS[e.code];
  if (chars && (chars[0] === key || chars[1] === key)) return null;
  // letters/digits whose code the keycode map covers still differ by layout (e.g. AZERTY 'a' on KeyQ)
  if (CODE_TO_KEYCODE[e.code] !== undefined && chars === undefined) return null;
  return key;
}

/** Split `text` into INJECT_TEXT messages, each ≤ 300 UTF-8 bytes on a code-point boundary. */
export function pasteText(send: SendControl, text: string): void {
  const encoder = new TextEncoder();
  let chunk = "";
  let chunkBytes = 0;
  for (const cp of text) {
    const n = encoder.encode(cp).length;
    if (chunkBytes + n > INJECT_TEXT_MAX_LENGTH) {
      send(injectText(chunk));
      chunk = "";
      chunkBytes = 0;
    }
    chunk += cp;
    chunkBytes += n;
  }
  if (chunk.length > 0) send(injectText(chunk));
}

/** Elements whose own keystrokes must not be forwarded to the device. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}
