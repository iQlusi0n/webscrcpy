/**
 * Touch mode: Pointer Events on the canvas → INJECT_TOUCH_EVENT / INJECT_SCROLL_EVENT.
 * Mouse → POINTER_ID_MOUSE with the MotionEvent button mask; touches/pens → small integer ids.
 * Ctrl+drag simulates a second finger mirrored through the canvas centre (Ctrl+Shift: through the
 * pointer-down anchor), drawn on the overlay canvas. Right button → BACK, middle → HOME.
 */
import {
  KeyAction,
  MotionAction,
  MotionButton,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_MOUSE,
  POINTER_ID_VIRTUAL_FINGER,
} from "@common/scrcpy.ts";
import { injectKeycode, injectScroll, injectTouch } from "../control.ts";
import type { ScreenInfo } from "../video.ts";
import { AndroidKey } from "./keycodes.ts";
import type { SendControl } from "./text.ts";

export interface DevicePoint {
  x: number;
  y: number;
}

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

interface ActivePointer {
  id: bigint;
  last: DevicePoint;
  /** multi-touch simulation state, mouse only */
  mirror: { anchor: DevicePoint; virtual: DevicePoint } | null;
}

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
  private readonly active = new Map<number, ActivePointer>();
  private nextTouchId = 0;
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

  /** Send UP/CANCEL for every tracked pointer and release held mouse buttons. */
  releaseAll(): void {
    for (const [pointerId, p] of this.active) {
      this.finish(pointerId, p, MotionAction.CANCEL);
    }
    this.active.clear();
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
      const stale = this.active.get(e.pointerId);
      if (stale) this.finish(e.pointerId, stale, MotionAction.UP);
      const mirrored = e.ctrlKey;
      const id = mirrored ? POINTER_ID_GENERIC_FINGER : POINTER_ID_MOUSE;
      const entry: ActivePointer = { id, last: point, mirror: null };
      this.active.set(e.pointerId, entry);
      this.touch(
        this.active.size === 1 ? MotionAction.DOWN : MotionAction.POINTER_DOWN,
        id,
        point,
        1,
        mirrored ? 0 : MotionButton.PRIMARY,
        mirrored ? 0 : this.mouseButtons,
      );
      if (mirrored) this.startMirror(entry, point, e.shiftKey);
      return;
    }
    if (!point) return;
    this.canvas.setPointerCapture(e.pointerId);
    const stale = this.active.get(e.pointerId);
    if (stale) this.finish(e.pointerId, stale, MotionAction.UP);
    const id = BigInt(this.nextTouchId++ % 10);
    this.active.set(e.pointerId, { id, last: point, mirror: null });
    this.touch(
      this.active.size === 1 ? MotionAction.DOWN : MotionAction.POINTER_DOWN,
      id,
      point,
      e.pressure || 1,
      0,
      0,
    );
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const entry = this.active.get(e.pointerId);
    const point = this.toDevice(e);
    if (!entry) {
      // orphan MOVE with a pressed primary button: synthesize the DOWN first
      if (point && e.pointerType !== "mouse" && e.buttons !== 0) this.onPointerDown(e);
      return;
    }
    if (!point) return;
    entry.last = point;
    const pressure = e.pointerType === "mouse" ? 1 : e.pressure || 1;
    this.touch(MotionAction.MOVE, entry.id, point, pressure, 0, entry.mirror ? 0 : this.mouseButtons);
    if (entry.mirror) {
      entry.mirror.virtual = mirrorPoint(point, entry.mirror.anchor);
      this.touch(MotionAction.MOVE, POINTER_ID_VIRTUAL_FINGER, entry.mirror.virtual, 1, 0, 0);
      this.drawMarkers(point, entry.mirror.virtual);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") {
      const button = BUTTON_TO_MOTION[e.button] ?? 0;
      this.mouseButtons &= ~button;
      if (button === MotionButton.SECONDARY) {
        this.key(AndroidKey.BACK, false);
        return;
      }
      if (button === MotionButton.TERTIARY) {
        this.key(AndroidKey.HOME, false);
        return;
      }
      if (button !== MotionButton.PRIMARY) return;
    }
    const entry = this.active.get(e.pointerId);
    if (!entry) return;
    const point = this.toDevice(e);
    if (point) entry.last = point;
    this.active.delete(e.pointerId);
    this.finish(e.pointerId, entry, this.active.size === 0 ? MotionAction.UP : MotionAction.POINTER_UP);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    const entry = this.active.get(e.pointerId);
    if (!entry) return;
    this.active.delete(e.pointerId);
    this.finish(e.pointerId, entry, MotionAction.CANCEL);
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    // captured pointers keep delivering events; only uncaptured ones are lost here
    if (this.canvas.hasPointerCapture(e.pointerId)) return;
    const entry = this.active.get(e.pointerId);
    if (!entry) return;
    this.active.delete(e.pointerId);
    this.finish(e.pointerId, entry, MotionAction.UP);
  };

  private readonly onModifierKey = (e: KeyboardEvent): void => {
    if (e.repeat || (e.key !== "Control" && e.key !== "Shift")) return;
    for (const entry of this.active.values()) {
      if (entry.id !== POINTER_ID_GENERIC_FINGER || !entry.mirror) continue;
      if (e.key === "Control" && e.type === "keyup") {
        this.touch(MotionAction.POINTER_UP, POINTER_ID_VIRTUAL_FINGER, entry.mirror.virtual, 0, 0, 0);
        entry.mirror = null;
        this.clearOverlay();
      } else if (e.key === "Shift") {
        entry.mirror.anchor = e.type === "keydown" ? entry.last : this.center();
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

  private startMirror(entry: ActivePointer, point: DevicePoint, throughAnchor: boolean): void {
    const anchor = throughAnchor ? point : this.center();
    const virtual = mirrorPoint(point, anchor);
    entry.mirror = { anchor, virtual };
    this.touch(MotionAction.POINTER_DOWN, POINTER_ID_VIRTUAL_FINGER, virtual, 1, 0, 0);
    this.drawMarkers(point, virtual);
  }

  private finish(pointerId: number, p: ActivePointer, action: number): void {
    if (p.mirror) {
      this.touch(MotionAction.POINTER_UP, POINTER_ID_VIRTUAL_FINGER, p.mirror.virtual, 0, 0, 0);
      this.clearOverlay();
    }
    const isMouse = p.id === POINTER_ID_MOUSE;
    this.touch(action, p.id, p.last, 0, isMouse ? MotionButton.PRIMARY : 0, isMouse ? this.mouseButtons : 0);
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  private touch(
    action: number,
    id: bigint,
    point: DevicePoint,
    pressure: number,
    actionButton: number,
    buttons: number,
  ): void {
    this.send(
      injectTouch({
        action,
        pointerId: id,
        x: Math.min(point.x, Math.max(0, this.screen.width - 1)),
        y: Math.min(point.y, Math.max(0, this.screen.height - 1)),
        screenWidth: this.screen.width,
        screenHeight: this.screen.height,
        pressure,
        actionButton,
        buttons,
      }),
    );
  }

  private key(keycode: number, down: boolean): void {
    this.send(injectKeycode(down ? KeyAction.DOWN : KeyAction.UP, keycode, 0, 0));
  }

  private drawMarkers(real: DevicePoint, virtual: DevicePoint): void {
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
      [virtual, "rgba(255, 120, 0, 0.8)"],
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

/** Reflect `p` through `anchor`, clamped to non-negative coordinates. */
export function mirrorPoint(p: DevicePoint, anchor: DevicePoint): DevicePoint {
  return { x: Math.max(0, 2 * anchor.x - p.x), y: Math.max(0, 2 * anchor.y - p.y) };
}
