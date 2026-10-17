/**
 * Touch mode: Pointer Events on the canvas → INJECT_TOUCH_EVENT / INJECT_SCROLL_EVENT.
 * Mouse → POINTER_ID_MOUSE with the MotionEvent button mask; touches/pens → small integer ids.
 * Ctrl+drag simulates a second finger mirrored through the canvas centre (Ctrl+Shift: through the
 * pointer-down anchor), drawn on the overlay canvas. Right button → BACK, middle → HOME.
 */
import { KeyAction, MotionButton, POINTER_ID_GENERIC_FINGER, POINTER_ID_MOUSE } from "@common/scrcpy.ts";
import { injectKeycode, injectScroll, injectTouch } from "../control.ts";
import type { ScreenInfo } from "../video.ts";
import { AndroidKey } from "./keycodes.ts";
import { type DevicePoint, PointerState, type TouchAction } from "./pointerState.ts";
import type { SendControl } from "./text.ts";

export type { DevicePoint } from "./pointerState.ts";

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a client-space point to device pixels, honouring letterboxing when the element's aspect
 * ratio differs from the video's. Returns null outside the picture.
 */
export function mapToDevice(
  clientX: number,
  clientY: number,
  rect: ElementRect,
  screen: ScreenInfo,
): DevicePoint | null {
  if (screen.width <= 0 || screen.height <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / screen.width, rect.height / screen.height);
  const drawW = screen.width * scale;
  const drawH = screen.height * scale;
  const offX = rect.left + (rect.width - drawW) / 2;
  const offY = rect.top + (rect.height - drawH) / 2;
  const x = (clientX - offX) / scale;
  const y = (clientY - offY) / scale;
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return null;
  return { x: Math.floor(x + 1e-6), y: Math.floor(y + 1e-6) };
}

export const SCROLL_DIVISOR = 128;
export const SCROLL_THROTTLE_MS = 30;

/** Browser wheel deltas → scrcpy scroll amounts in [-1,1]; wheel-down scrolls content up (negative). */
export function wheelToScroll(deltaX: number, deltaY: number): { hscroll: number; vscroll: number } {
  return {
    hscroll: Math.max(-1, Math.min(1, deltaX / SCROLL_DIVISOR)),
    vscroll: Math.max(-1, Math.min(1, -deltaY / SCROLL_DIVISOR)),
  };
}

const BUTTON_TO_MOTION: Record<number, number> = {
  0: MotionButton.PRIMARY,
  1: MotionButton.TERTIARY,
  2: MotionButton.SECONDARY,
  3: MotionButton.BACK,
  4: MotionButton.FORWARD,
};

export interface TouchInputOptions {
  send: SendControl;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  screen: ScreenInfo;
}

export class TouchInput {
  private readonly send: SendControl;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly screen: ScreenInfo;
  private enabled = false;
  private readonly pointers = new PointerState();
  private mouseButtons = 0;
  private lastScrollAt = 0;
  private pendingScroll: { x: number; y: number; hscroll: number; vscroll: number } | null = null;
  private scrollTimer: number | undefined;

  constructor(opts: TouchInputOptions) {
    this.send = opts.send;
    this.canvas = opts.canvas;
    this.overlay = opts.overlay;
    this.screen = opts.screen;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    const c = this.canvas;
    if (enabled) {
      c.addEventListener("pointerdown", this.onPointerDown);
      c.addEventListener("pointermove", this.onPointerMove);
      c.addEventListener("pointerup", this.onPointerUp);
      c.addEventListener("pointercancel", this.onPointerCancel);
      c.addEventListener("pointerleave", this.onPointerLeave);
      c.addEventListener("wheel", this.onWheel, { passive: false });
      c.addEventListener("contextmenu", this.onContextMenu);
      document.addEventListener("keydown", this.onModifierKey);
      document.addEventListener("keyup", this.onModifierKey);
    } else {
      c.removeEventListener("pointerdown", this.onPointerDown);
      c.removeEventListener("pointermove", this.onPointerMove);
      c.removeEventListener("pointerup", this.onPointerUp);
      c.removeEventListener("pointercancel", this.onPointerCancel);
      c.removeEventListener("pointerleave", this.onPointerLeave);
      c.removeEventListener("wheel", this.onWheel);
      c.removeEventListener("contextmenu", this.onContextMenu);
      document.removeEventListener("keydown", this.onModifierKey);
      document.removeEventListener("keyup", this.onModifierKey);
      this.releaseAll();
      clearTimeout(this.scrollTimer);
      this.scrollTimer = undefined;
      this.pendingScroll = null;
    }
  }

  destroy(): void {
    this.setEnabled(false);
  }

  /** Send UP for every tracked pointer and release held mouse buttons. */
  releaseAll(): void {
    this.emit(this.pointers.releaseAll(this.mouseButtons));
    if (this.mouseButtons & MotionButton.SECONDARY) this.key(AndroidKey.BACK, false);
    if (this.mouseButtons & MotionButton.TERTIARY) this.key(AndroidKey.HOME, false);
    this.mouseButtons = 0;
    this.clearOverlay();
  }

  // ---------------------------------------------------------------- listeners

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private readonly onPointerDown = (e: PointerEvent): void => {
    const point = this.toDevice(e);
    if (e.pointerType === "mouse") {
      const button = BUTTON_TO_MOTION[e.button] ?? 0;
      this.mouseButtons |= button;
      if (button === MotionButton.SECONDARY) {
        this.key(AndroidKey.BACK, true);
        return;
      }
      if (button === MotionButton.TERTIARY) {
        this.key(AndroidKey.HOME, true);
        return;
      }
      if (button !== MotionButton.PRIMARY || !point) return;
      this.canvas.setPointerCapture(e.pointerId);
      const mirrored = e.ctrlKey;
      const id = mirrored ? POINTER_ID_GENERIC_FINGER : POINTER_ID_MOUSE;
      const anchor = mirrored ? (e.shiftKey ? point : this.center()) : null;
      this.emit(this.pointers.down(e.pointerId, id, point, 1, this.mouseButtons, anchor));
      this.drawMirror(e.pointerId, point);
      return;
    }
    if (!point) return;
    this.canvas.setPointerCapture(e.pointerId);
    const id = this.pointers.freeTouchId();
    this.emit(this.pointers.down(e.pointerId, id, point, e.pressure || 1, 0, null));
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const point = this.toDevice(e);
    if (!this.pointers.has(e.pointerId)) {
      // orphan MOVE with a pressed contact: synthesize the DOWN first
      if (point && e.pointerType !== "mouse" && e.buttons !== 0) this.onPointerDown(e);
      return;
    }
    // a second button pressed/released while another is held arrives as pointermove
    if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
      this.mouseButtons &= ~MotionButton.PRIMARY;
      this.release(e.pointerId, point);
      return;
    }
    if (!point) return;
    const pressure = e.pointerType === "mouse" ? 1 : e.pressure || 1;
    this.emit(this.pointers.move(e.pointerId, point, pressure, this.mouseButtons));
    this.drawMirror(e.pointerId, point);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") {
      const button = BUTTON_TO_MOTION[e.button] ?? 0;
      this.mouseButtons &= ~button;
      if (button === MotionButton.SECONDARY) this.key(AndroidKey.BACK, false);
      else if (button === MotionButton.TERTIARY) this.key(AndroidKey.HOME, false);
      if (button !== MotionButton.PRIMARY && (e.buttons & 1) !== 0) return;
      this.mouseButtons &= ~MotionButton.PRIMARY;
    }
    this.release(e.pointerId, this.toDevice(e));
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.release(e.pointerId, null);
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    // captured pointers keep delivering events; only uncaptured ones are lost here
    if (this.canvas.hasPointerCapture(e.pointerId)) return;
    this.release(e.pointerId, null);
  };

  private readonly onModifierKey = (e: KeyboardEvent): void => {
    if (e.repeat || (e.key !== "Control" && e.key !== "Shift")) return;
    for (const pointerId of this.pointers.mirrored()) {
      if (e.key === "Control" && e.type === "keyup") {
        this.emit(this.pointers.endMirror(pointerId));
        this.clearOverlay();
      } else if (e.key === "Shift") {
        this.pointers.setAnchor(pointerId, e.type === "keydown" ? "last" : this.center());
      }
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const point = this.toDevice(e);
    if (!point) return;
    const { hscroll, vscroll } = wheelToScroll(e.deltaX, e.deltaY);
    this.pendingScroll = { x: point.x, y: point.y, hscroll, vscroll };
    const now = performance.now();
    const wait = SCROLL_THROTTLE_MS - (now - this.lastScrollAt);
    if (wait <= 0) {
      this.flushScroll();
    } else if (this.scrollTimer === undefined) {
      this.scrollTimer = window.setTimeout(() => {
        this.scrollTimer = undefined;
        this.flushScroll();
      }, wait);
    }
  };

  // ---------------------------------------------------------------- helpers

  private release(pointerId: number, point: DevicePoint | null): void {
    if (!this.pointers.has(pointerId)) return;
    const hadMirror = this.pointers.mirrorOf(pointerId) !== null;
    this.emit(this.pointers.up(pointerId, point, this.mouseButtons));
    if (hadMirror) this.clearOverlay();
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  private emit(actions: TouchAction[]): void {
    const maxX = Math.max(0, this.screen.width - 1);
    const maxY = Math.max(0, this.screen.height - 1);
    for (const a of actions) {
      this.send(
        injectTouch({
          action: a.action,
          pointerId: a.id,
          x: Math.min(a.point.x, maxX),
          y: Math.min(a.point.y, maxY),
          screenWidth: this.screen.width,
          screenHeight: this.screen.height,
          pressure: a.pressure,
          actionButton: a.actionButton,
          buttons: a.buttons,
        }),
      );
    }
  }

  private flushScroll(): void {
    const s = this.pendingScroll;
    if (!s) return;
    this.pendingScroll = null;
    this.lastScrollAt = performance.now();
    this.send(
      injectScroll({
        x: s.x,
        y: s.y,
        screenWidth: this.screen.width,
        screenHeight: this.screen.height,
        hscroll: s.hscroll,
        vscroll: s.vscroll,
        buttons: this.mouseButtons,
      }),
    );
  }

  private toDevice(e: MouseEvent): DevicePoint | null {
    return mapToDevice(e.clientX, e.clientY, this.canvas.getBoundingClientRect(), this.screen);
  }

  private center(): DevicePoint {
    return { x: Math.floor(this.screen.width / 2), y: Math.floor(this.screen.height / 2) };
  }

  private key(keycode: number, down: boolean): void {
    this.send(injectKeycode(down ? KeyAction.DOWN : KeyAction.UP, keycode, 0, 0));
  }

  private drawMirror(pointerId: number, real: DevicePoint): void {
    const mirror = this.pointers.mirrorOf(pointerId);
    if (!mirror) return;
    const ov = this.overlay;
    if (ov.width !== this.screen.width || ov.height !== this.screen.height) {
      ov.width = this.screen.width;
      ov.height = this.screen.height;
    }
    const ctx = ov.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ov.width, ov.height);
    const radius = Math.max(8, Math.round(Math.min(ov.width, ov.height) / 40));
    ctx.lineWidth = Math.max(2, radius / 4);
    for (const [p, color] of [
      [real, "rgba(0, 200, 255, 0.8)"],
      [mirror.virtual, "rgba(255, 120, 0, 0.8)"],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private clearOverlay(): void {
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}
