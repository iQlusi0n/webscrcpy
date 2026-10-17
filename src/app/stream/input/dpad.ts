/**
 * D-pad mode (TVs): left click → DPAD_CENTER; wheel → DPAD_UP/DOWN (Shift: LEFT/RIGHT), fired
 * immediately and then ignored for 400 ms.
 */
import { KeyAction } from "@common/scrcpy.ts";
import { injectKeycode } from "../control.ts";
import { AndroidKey } from "./keycodes.ts";
import type { SendControl } from "./text.ts";

export const DPAD_WHEEL_DEBOUNCE_MS = 400;

/** Which D-pad key a wheel event maps to, or null for a zero delta. Exported for tests. */
export function dpadKeyForWheel(deltaX: number, deltaY: number, shift: boolean): number | null {
  if (shift) {
    const d = deltaY !== 0 ? deltaY : deltaX;
    if (d === 0) return null;
    return d > 0 ? AndroidKey.DPAD_RIGHT : AndroidKey.DPAD_LEFT;
  }
  if (deltaY !== 0) return deltaY > 0 ? AndroidKey.DPAD_DOWN : AndroidKey.DPAD_UP;
  if (deltaX !== 0) return deltaX > 0 ? AndroidKey.DPAD_RIGHT : AndroidKey.DPAD_LEFT;
  return null;
}

export class DpadInput {
  private enabled = false;
  private lastWheelAt = 0;

  constructor(
    private readonly send: SendControl,
    private readonly canvas: HTMLElement,
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.canvas.addEventListener("pointerdown", this.onPointerDown);
      this.canvas.addEventListener("pointerup", this.onPointerUp);
      this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
      this.canvas.addEventListener("contextmenu", this.onContextMenu);
    } else {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
  }

  destroy(): void {
    this.setEnabled(false);
  }

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private readonly onPointerDown = (e: PointerEvent): void => {
    const key = e.button === 0 ? AndroidKey.DPAD_CENTER : e.button === 2 ? AndroidKey.BACK : e.button === 1 ? AndroidKey.HOME : null;
    if (key === null) return;
    this.send(injectKeycode(KeyAction.DOWN, key, 0, 0));
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const key = e.button === 0 ? AndroidKey.DPAD_CENTER : e.button === 2 ? AndroidKey.BACK : e.button === 1 ? AndroidKey.HOME : null;
    if (key === null) return;
    this.send(injectKeycode(KeyAction.UP, key, 0, 0));
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const now = performance.now();
    if (now - this.lastWheelAt < DPAD_WHEEL_DEBOUNCE_MS) return;
    const key = dpadKeyForWheel(e.deltaX, e.deltaY, e.shiftKey);
    if (key === null) return;
    this.lastWheelAt = now;
    this.send(injectKeycode(KeyAction.DOWN, key, 0, 0));
    this.send(injectKeycode(KeyAction.UP, key, 0, 0));
  };
}
