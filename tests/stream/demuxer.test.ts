import { describe, expect, test } from "bun:test";
import { PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME } from "@common/scrcpy.ts";
import { classifyClose, DeviceMessageReassembler, parseMediaPacket } from "../../src/app/stream/demuxer.ts";

function mediaFrame(ptsAndFlags: bigint, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, ptsAndFlags);
  view.setUint32(8, payload.length);
  out.set(payload, 12);
  return out;
}

describe("parseMediaPacket", () => {
  test("extracts pts and flag bits", () => {
    const p = parseMediaPacket(mediaFrame(PTS_FLAG_KEYFRAME | 123456n, Uint8Array.of(9, 8, 7)));
    expect(p).not.toBeNull();
    expect(p!.pts).toBe(123456n);
    expect(p!.isKeyframe).toBe(true);
    expect(p!.isConfig).toBe(false);
    expect(Array.from(p!.data)).toEqual([9, 8, 7]);
  });
  test("config flag", () => {
    const p = parseMediaPacket(mediaFrame(PTS_FLAG_CONFIG, Uint8Array.of(1)));
    expect(p!.isConfig).toBe(true);
    expect(p!.pts).toBe(0n);
  });
  test("truncated frames are rejected", () => {
    expect(parseMediaPacket(new Uint8Array(11))).toBeNull();
    const short = mediaFrame(0n, Uint8Array.of(1, 2, 3)).subarray(0, 14);
    expect(parseMediaPacket(short)).toBeNull();
  });
});

describe("DeviceMessageReassembler", () => {
  const clipboard = Uint8Array.of(0, 0, 0, 0, 2, 0x68, 0x69); // "hi"
  const ack = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 7);
  const uhid = Uint8Array.of(2, 0, 1, 0, 2, 0xaa, 0xbb);

  test("parses several messages from one chunk", () => {
    const r = new DeviceMessageReassembler();
    const all = new Uint8Array([...clipboard, ...ack, ...uhid]);
    const out = r.push(all);
    expect(out).toEqual([
      { type: "clipboard", text: "hi" },
      { type: "ack-clipboard", sequence: 7n },
      { type: "uhid-output", id: 1, data: Uint8Array.of(0xaa, 0xbb) },
    ]);
  });

  test("reassembles across arbitrary chunk boundaries", () => {
    const all = new Uint8Array([...clipboard, ...ack, ...uhid]);
    for (let cut = 1; cut < all.length; cut++) {
      const r = new DeviceMessageReassembler();
      const out = [...r.push(all.subarray(0, cut)), ...r.push(all.subarray(cut))];
      expect(out.map((m) => m.type)).toEqual(["clipboard", "ack-clipboard", "uhid-output"]);
    }
  });

  test("byte-at-a-time", () => {
    const r = new DeviceMessageReassembler();
    const out = [];
    for (const b of clipboard) out.push(...r.push(Uint8Array.of(b)));
    expect(out).toEqual([{ type: "clipboard", text: "hi" }]);
  });

  test("unknown type stops reassembly", () => {
    const r = new DeviceMessageReassembler();
    expect(r.push(Uint8Array.of(...ack, 9, 1, 2))).toHaveLength(1);
    expect(r.desynced).toBe(true);
    expect(r.push(ack)).toHaveLength(0);
  });
});

describe("classifyClose", () => {
  test("normal codes", () => {
    expect(classifyClose(1000, "")).toEqual({ kind: "normal" });
    expect(classifyClose(1001, "bye")).toEqual({ kind: "normal", reason: "bye" });
    expect(classifyClose(1005, "")).toEqual({ kind: "normal" });
  });
  test("error codes carry the reason or a default message", () => {
    const withReason = classifyClose(4005, "encoder failed");
    expect(withReason.kind).toBe("error");
    if (withReason.kind === "error") expect(withReason.error.message).toBe("encoder failed");
    const noReason = classifyClose(1006, "");
    if (noReason.kind === "error") expect(noReason.error.message).toBe("WebSocket closed with code 1006");
  });
});
