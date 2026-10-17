import { describe, expect, test } from "bun:test";
import { ChannelId } from "@common/protocol.ts";
import { PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME } from "@common/scrcpy.ts";
import { buildMediaFrame, decodeDeviceName, parseFrameHeader, readU32 } from "../../src/server/adb/frames.ts";

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

describe("parseFrameHeader", () => {
  test("session packet: bit 63 set, flags and width from the first 8 bytes", () => {
    const head = new Uint8Array(8);
    const view = new DataView(head.buffer);
    view.setUint32(0, 0x8000_0001);
    view.setUint32(4, 1080);
    expect(parseFrameHeader(head)).toEqual({ kind: "session", flags: 1, width: 1080 });
  });

  test("media packet: config and keyframe flags, PTS masked", () => {
    const pts = 123_456_789n;
    expect(parseFrameHeader(u64(pts))).toEqual({ kind: "media", config: false, keyframe: false, pts });
    expect(parseFrameHeader(u64(PTS_FLAG_CONFIG))).toEqual({ kind: "media", config: true, keyframe: false, pts: 0n });
    expect(parseFrameHeader(u64(PTS_FLAG_KEYFRAME | pts))).toEqual({ kind: "media", config: false, keyframe: true, pts });
  });

  test("rejects short input", () => {
    expect(() => parseFrameHeader(new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("buildMediaFrame", () => {
  test("copies channel, 8-byte header, 4-byte size and payload verbatim", () => {
    const head = u64(PTS_FLAG_KEYFRAME | 42n);
    const size = new Uint8Array([0, 0, 0, 3]);
    const payload = new Uint8Array([9, 8, 7]);
    const frame = buildMediaFrame(ChannelId.VIDEO, head, size, payload);
    expect(frame.byteLength).toBe(1 + 12 + 3);
    expect(frame[0]).toBe(ChannelId.VIDEO);
    expect(frame.subarray(1, 9)).toEqual(head);
    expect(readU32(frame.subarray(9, 13))).toBe(3);
    expect(frame.subarray(13)).toEqual(payload);
  });
});

describe("decodeDeviceName", () => {
  test("stops at the first NUL of the 64-byte field", () => {
    const field = new Uint8Array(64);
    field.set(new TextEncoder().encode("Pixel 8"));
    expect(decodeDeviceName(field)).toBe("Pixel 8");
  });
});
