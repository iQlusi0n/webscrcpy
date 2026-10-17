import { describe, expect, test } from "bun:test";
import { CongestionController } from "../../src/server/adb/congestion.ts";

const MiB = 1024 * 1024;
const delta = { channel: "video", config: false, keyframe: false } as const;
const key = { channel: "video", config: false, keyframe: true } as const;
const config = { channel: "video", config: true, keyframe: false } as const;
const audio = { channel: "audio", config: false, keyframe: false } as const;

describe("CongestionController", () => {
  test("flows while buffered amount is under the high-water mark", () => {
    const c = new CongestionController();
    expect(c.decide(3 * MiB, delta)).toEqual({ send: true, reset: false, event: undefined });
    expect(c.state).toBe("flowing");
  });

  test("sheds media above 4 MiB, never config packets", () => {
    const c = new CongestionController();
    expect(c.decide(5 * MiB, delta)).toEqual({ send: false, reset: false, event: "congested" });
    expect(c.decide(5 * MiB, key)).toMatchObject({ send: false });
    expect(c.decide(5 * MiB, audio)).toMatchObject({ send: false });
    expect(c.decide(5 * MiB, config)).toMatchObject({ send: true });
    expect(c.dropped).toBe(3);
  });

  test("stays congested between low and high water, requests a reset at ≤ 1 MiB", () => {
    const c = new CongestionController();
    c.decide(5 * MiB, delta);
    expect(c.decide(2 * MiB, delta)).toMatchObject({ send: false, reset: false });
    expect(c.decide(1 * MiB, delta)).toEqual({ send: false, reset: true, event: "drained" });
    expect(c.state).toBe("awaiting-keyframe");
  });

  test("after draining, audio resumes at once and video waits for a keyframe", () => {
    const c = new CongestionController();
    c.decide(5 * MiB, delta);
    c.decide(0, delta);
    expect(c.decide(0, audio)).toMatchObject({ send: true, reset: false });
    expect(c.decide(0, delta)).toMatchObject({ send: false });
    expect(c.decide(0, key)).toEqual({ send: true, reset: false, event: "resumed" });
    expect(c.state).toBe("flowing");
    expect(c.decide(0, delta)).toMatchObject({ send: true });
  });

  test("re-congests while awaiting a keyframe", () => {
    const c = new CongestionController();
    c.decide(5 * MiB, delta);
    c.decide(0, delta);
    expect(c.decide(5 * MiB, key)).toEqual({ send: false, reset: false, event: "congested" });
  });

  test("custom thresholds", () => {
    const c = new CongestionController(100, 10);
    expect(c.decide(101, delta).event).toBe("congested");
    expect(c.decide(10, delta).reset).toBe(true);
  });
});
