/**
 * Keycode keyboard path: document keydown/keyup → INJECT_KEYCODE while the stream container has
 * focus-within or the pointer is over the canvas. Printable keys the keycode table cannot express
 * go through INJECT_TEXT instead (text.ts).
 */
import { KeyAction } from "@common/scrcpy.ts";
import { injectKeycode, injectText } from "../control.ts";
import { CODE_TO_KEYCODE, metaStateOf } from "./keycodes.ts";
import { isTextEntry, type SendControl, textForKey } from "./text.ts";

export interface KeyboardInputOptions {
  send: SendControl;
  container: HTMLElement;
  canvas: HTMLElement;
}

export class KeyboardInput {
  private readonly send: SendControl;
  private readonly container: HTMLElement;
  private readonly canvas: HTMLElement;
  private pointerOver = false;
  private enabled = false;
  /** consecutive repeats per code, reset on keyup */
  private readonly repeats = new Map<string, number>();
  /** codes whose keydown was sent as text; their keyup is swallowed */
  private readonly textCodes = new Set<string>();

  private readonly onKeyDown = (e: KeyboardEvent): void => this.handle(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.handle(e, false);
  private readonly onEnter = (): void => {
    this.pointerOver = true;
  };
  private readonly onLeave = (): void => {
    this.pointerOver = false;
  };

  constructor(opts: KeyboardInputOptions) {
    this.send = opts.send;
    this.container = opts.container;
    this.canvas = opts.canvas;
    this.canvas.addEventListener("pointerenter", this.onEnter);
    this.canvas.addEventListener("pointerleave", this.onLeave);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      document.addEventListener("keydown", this.onKeyDown);
      document.addEventListener("keyup", this.onKeyUp);
    } else {
      document.removeEventListener("keydown", this.onKeyDown);
      document.removeEventListener("keyup", this.onKeyUp);
      this.repeats.clear();
      this.textCodes.clear();
    }
  }

  destroy(): void {
    this.setEnabled(false);
    this.canvas.removeEventListener("pointerenter", this.onEnter);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
  }

  private isActive(): boolean {
    if (this.pointerOver) return true;
    const active = document.activeElement;
    if (!active || active === document.body) return this.container.matches(":focus-within");
    return this.container.contains(active) && !isTextEntry(active);
  }

  private handle(e: KeyboardEvent, down: boolean): void {
    if (!this.isActive()) return;
    if (isTextEntry(document.activeElement) || e.target instanceof HTMLButtonElement) return;
    if (down) {
      const text = textForKey(e);
      if (text !== null) {
        this.send(injectText(text));
        this.textCodes.add(e.code);
        e.preventDefault();
        return;
      }
    } else if (this.textCodes.delete(e.code)) {
      e.preventDefault();
      return;
    }
    const keycode = CODE_TO_KEYCODE[e.code];
    if (keycode === undefined) return;
    let repeat = 0;
    if (down) {
      repeat = e.repeat ? (this.repeats.get(e.code) ?? 0) + 1 : 0;
      this.repeats.set(e.code, repeat);
    } else {
      this.repeats.delete(e.code);
    }
    this.send(injectKeycode(down ? KeyAction.DOWN : KeyAction.UP, keycode, repeat, metaStateOf(e)));
    e.preventDefault();
  }
}
