import { describe, expect, test } from "bun:test";
import { PointerState, type TouchAction } from "../../src/app/stream/input/pointerState.ts";
import {
  MotionAction,
  MotionButton,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_MOUSE,
  POINTER_ID_VIRTUAL_FINGER,
} from "../../src/common/scrcpy.ts";

const brief = (actions: TouchAction[]): [number, bigint][] => actions.map((a) => [a.action, a.id]);
const { DOWN, UP, MOVE } = MotionAction;

describe("PointerState action sequencing", () => {
  test("two fingers down and up emit only DOWN/UP per id", () => {
    const s = new PointerState();
    expect(brief(s.down(10, 0n, { x: 1, y: 1 }, 1, 0, null))).toEqual([[DOWN, 0n]]);
    expect(brief(s.down(11, 1n, { x: 2, y: 2 }, 1, 0, null))).toEqual([[DOWN, 1n]]);
    expect(brief(s.move(11, { x: 3, y: 3 }, 1, 0))).toEqual([[MOVE, 1n]]);
    expect(brief(s.up(11, { x: 3, y: 3 }, 0))).toEqual([[UP, 1n]]);
    expect(brief(s.up(10, null, 0))).toEqual([[UP, 0n]]);
    expect(s.size).toBe(0);
  });

  test("cancel/leave and releaseAll end every pointer with UP", () => {
    const s = new PointerState();
    s.down(1, 0n, { x: 0, y: 0 }, 1, 0, null);
    expect(brief(s.up(1, null, 0))).toEqual([[UP, 0n]]);
    s.down(2, 0n, { x: 0, y: 0 }, 1, 0, null);
    s.down(3, 1n, { x: 0, y: 0 }, 1, 0, null);
    expect(brief(s.releaseAll(0))).toEqual([
      [UP, 0n],
      [UP, 1n],
    ]);
    expect(s.size).toBe(0);
    expect(s.releaseAll(0)).toEqual([]);
  });

  test("mirror pinch: virtual finger gets DOWN/MOVE/UP and never POINTER_* actions", () => {
    const s = new PointerState();
    const seq = [
      ...s.down(1, POINTER_ID_GENERIC_FINGER, { x: 100, y: 100 }, 1, 0, { x: 500, y: 500 }),
      ...s.move(1, { x: 150, y: 120 }, 1, 0),
      ...s.up(1, { x: 150, y: 120 }, 0),
    ];
    expect(brief(seq)).toEqual([
      [DOWN, POINTER_ID_GENERIC_FINGER],
      [DOWN, POINTER_ID_VIRTUAL_FINGER],
      [MOVE, POINTER_ID_GENERIC_FINGER],
      [MOVE, POINTER_ID_VIRTUAL_FINGER],
      [UP, POINTER_ID_VIRTUAL_FINGER],
      [UP, POINTER_ID_GENERIC_FINGER],
    ]);
    expect(seq[1]?.point).toEqual({ x: 900, y: 900 });
    expect(seq[3]?.point).toEqual({ x: 850, y: 880 });
    expect(seq[4]?.pressure).toBe(0);
    for (const a of seq) expect(a.action === DOWN || a.action === UP || a.action === MOVE).toBe(true);
  });

  test("releasing Ctrl lifts only the virtual finger; the real one continues", () => {
    const s = new PointerState();
    s.down(1, POINTER_ID_GENERIC_FINGER, { x: 10, y: 10 }, 1, 0, { x: 50, y: 50 });
    expect(brief(s.endMirror(1))).toEqual([[UP, POINTER_ID_VIRTUAL_FINGER]]);
    expect(s.endMirror(1)).toEqual([]);
    expect(brief(s.move(1, { x: 11, y: 11 }, 1, 0))).toEqual([[MOVE, POINTER_ID_GENERIC_FINGER]]);
    expect(brief(s.up(1, null, 0))).toEqual([[UP, POINTER_ID_GENERIC_FINGER]]);
  });

  test("stale down for the same browser pointer is released first", () => {
    const s = new PointerState();
    s.down(7, 0n, { x: 5, y: 5 }, 1, 0, null);
    expect(brief(s.down(7, 1n, { x: 6, y: 6 }, 1, 0, null))).toEqual([
      [UP, 0n],
      [DOWN, 1n],
    ]);
    expect(s.size).toBe(1);
  });

  test("mouse pointer carries PRIMARY action button and the held button mask", () => {
    const s = new PointerState();
    const [down] = s.down(1, POINTER_ID_MOUSE, { x: 0, y: 0 }, 1, MotionButton.PRIMARY, null);
    expect(down?.actionButton).toBe(MotionButton.PRIMARY);
    expect(down?.buttons).toBe(MotionButton.PRIMARY);
    const [up] = s.up(1, null, 0);
    expect(up?.actionButton).toBe(MotionButton.PRIMARY);
    expect(up?.buttons).toBe(0);
    expect(up?.pressure).toBe(0);
  });

  test("freeTouchId picks the lowest unused id in 0–9", () => {
    const s = new PointerState();
    expect(s.freeTouchId()).toBe(0n);
    s.down(1, s.freeTouchId(), { x: 0, y: 0 }, 1, 0, null);
    s.down(2, s.freeTouchId(), { x: 0, y: 0 }, 1, 0, null);
    expect(s.freeTouchId()).toBe(2n);
    s.up(1, null, 0);
    expect(s.freeTouchId()).toBe(0n);
    for (let i = 10; i < 19; i++) s.down(i, s.freeTouchId(), { x: 0, y: 0 }, 1, 0, null);
    expect(s.size).toBe(10);
    expect(s.freeTouchId()).toBe(0n);
  });
});
