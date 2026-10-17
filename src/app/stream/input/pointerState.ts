/**
 * Pure pointer-state machine behind TouchInput: tracks active pointers (plus the mirrored virtual
 * finger of a Ctrl-drag) and emits the INJECT_TOUCH_EVENT actions to send. Only MotionAction
 * DOWN/UP/MOVE are ever emitted, one per pointer id: scrcpy-server derives ACTION_POINTER_DOWN/UP
 * itself from its pointer table, and anything else (POINTER_*, CANCEL) leaves ghost pointers there.
 */
import { MotionAction, MotionButton, POINTER_ID_MOUSE, POINTER_ID_VIRTUAL_FINGER } from "@common/scrcpy.ts";

export interface DevicePoint {
  x: number;
  y: number;
}

export interface TouchAction {
  action: number;
  id: bigint;
  point: DevicePoint;
  pressure: number;
  actionButton: number;
  buttons: number;
}

export interface MirrorState {
  anchor: DevicePoint;
  virtual: DevicePoint;
}

interface ActivePointer {
  id: bigint;
  last: DevicePoint;
  /** multi-touch simulation state, mouse only */
  mirror: MirrorState | null;
}

/** Reflect `p` through `anchor`, clamped to non-negative coordinates. */
export function mirrorPoint(p: DevicePoint, anchor: DevicePoint): DevicePoint {
  return { x: Math.max(0, 2 * anchor.x - p.x), y: Math.max(0, 2 * anchor.y - p.y) };
}

const MAX_TOUCH_IDS = 10;

export class PointerState {
  private readonly active = new Map<number, ActivePointer>();

  get size(): number {
    return this.active.size;
  }

  has(pointerId: number): boolean {
    return this.active.has(pointerId);
  }

  mirrorOf(pointerId: number): MirrorState | null {
    return this.active.get(pointerId)?.mirror ?? null;
  }

  /** Pointers currently mirroring (Ctrl-drag). */
  *mirrored(): IterableIterator<number> {
    for (const [pointerId, p] of this.active) if (p.mirror) yield pointerId;
  }

  /** Lowest touch id in 0–9 not held by an active pointer; wraps to 0 when all are taken. */
  freeTouchId(): bigint {
    const used = new Set<bigint>();
    for (const p of this.active.values()) used.add(p.id);
    for (let i = 0; i < MAX_TOUCH_IDS; i++) if (!used.has(BigInt(i))) return BigInt(i);
    return 0n;
  }

  /**
   * Press `pointerId` as scrcpy pointer `id`. A stale entry for the same browser pointer is released
   * first. `anchor` starts the mirrored virtual finger (mouse only).
   */
  down(
    pointerId: number,
    id: bigint,
    point: DevicePoint,
    pressure: number,
    mouseButtons: number,
    anchor: DevicePoint | null,
  ): TouchAction[] {
    const out: TouchAction[] = [];
    const stale = this.active.get(pointerId);
    if (stale) this.finish(stale, out, mouseButtons);
    const entry: ActivePointer = { id, last: point, mirror: null };
    this.active.set(pointerId, entry);
    out.push(this.event(MotionAction.DOWN, entry, point, pressure, mouseButtons));
    if (anchor) {
      const virtual = mirrorPoint(point, anchor);
      entry.mirror = { anchor, virtual };
      out.push(virtualEvent(MotionAction.DOWN, virtual, 1));
    }
    return out;
  }

  move(pointerId: number, point: DevicePoint, pressure: number, mouseButtons: number): TouchAction[] {
    const entry = this.active.get(pointerId);
    if (!entry) return [];
    entry.last = point;
    const out = [this.event(MotionAction.MOVE, entry, point, pressure, mouseButtons)];
    if (entry.mirror) {
      entry.mirror.virtual = mirrorPoint(point, entry.mirror.anchor);
      out.push(virtualEvent(MotionAction.MOVE, entry.mirror.virtual, 1));
    }
    return out;
  }

  /** Release `pointerId` (pointerup, pointercancel and pointerleave all end in UP). */
  up(pointerId: number, point: DevicePoint | null, mouseButtons: number): TouchAction[] {
    const entry = this.active.get(pointerId);
    if (!entry) return [];
    if (point) entry.last = point;
    this.active.delete(pointerId);
    const out: TouchAction[] = [];
    this.finish(entry, out, mouseButtons);
    return out;
  }

  /** Lift the virtual finger of `pointerId` while the real one stays down (Ctrl released). */
  endMirror(pointerId: number): TouchAction[] {
    const entry = this.active.get(pointerId);
    if (!entry?.mirror) return [];
    const virtual = entry.mirror.virtual;
    entry.mirror = null;
    return [virtualEvent(MotionAction.UP, virtual, 0)];
  }

  /** Move the mirror anchor (Shift toggles between the canvas centre and the press point). */
  setAnchor(pointerId: number, anchor: DevicePoint | "last"): void {
    const entry = this.active.get(pointerId);
    if (!entry?.mirror) return;
    entry.mirror.anchor = anchor === "last" ? entry.last : anchor;
  }

  /** UP for every active pointer (virtual fingers first). */
  releaseAll(mouseButtons: number): TouchAction[] {
    const out: TouchAction[] = [];
    for (const entry of this.active.values()) this.finish(entry, out, mouseButtons);
    this.active.clear();
    return out;
  }

  private finish(entry: ActivePointer, out: TouchAction[], mouseButtons: number): void {
    if (entry.mirror) out.push(virtualEvent(MotionAction.UP, entry.mirror.virtual, 0));
    out.push(this.event(MotionAction.UP, entry, entry.last, 0, mouseButtons));
  }

  private event(
    action: number,
    entry: ActivePointer,
    point: DevicePoint,
    pressure: number,
    mouseButtons: number,
  ): TouchAction {
    const isMouse = entry.id === POINTER_ID_MOUSE;
    return {
      action,
      id: entry.id,
      point,
      pressure,
      actionButton: isMouse ? MotionButton.PRIMARY : 0,
      buttons: isMouse ? mouseButtons : 0,
    };
  }
}

function virtualEvent(action: number, point: DevicePoint, pressure: number): TouchAction {
  return { action, id: POINTER_ID_VIRTUAL_FINGER, point, pressure, actionButton: 0, buttons: 0 };
}
