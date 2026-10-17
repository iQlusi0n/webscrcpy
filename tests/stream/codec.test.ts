import { describe, expect, test } from "bun:test";
import {
  buildAvcC,
  buildConfigFromPacket,
  h264CodecString,
  h265CodecString,
  parseH264Sps,
  parseH265Sps,
  pickEncoder,
  selectCodec,
  splitAnnexB,
  stripEmulationPrevention,
} from "../../src/app/stream/codec.ts";
import { buildCodecOptions, buildStreamQuery, looksLikeNoPicture } from "../../src/app/stream/query.ts";

const hex = (s: string): Uint8Array =>
  Uint8Array.from(
    s
      .replace(/\s+/g, "")
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );

// x264, High profile level 4.0, 1920x1080 (coded 1088 with bottom crop)
const SPS_1080P = hex("67 64 00 28 AC D9 40 78 02 27 E5 C0 44 00 00 03 00 04 00 00 03 00 F0 3C 60 C6 58");
const PPS = hex("68 EB E3 CB 22 C0");
// x265 Main profile 1280x720
const HEVC_SPS = hex(
  "42 01 01 01 60 00 00 03 00 90 00 00 03 00 00 03 00 5D A0 02 80 80 2D 16 59 59 A4 93 2B C0 5A 70 80 00 01 F4 80 00 3A 98 04",
);

describe("codec preference selection", () => {
  const all = { h264: true, h265: true, av1: true, vp8: true, vp9: true } as const;

  test("prefers h265 when browser and device both support it, hardware encoder first", () => {
    const encoders = ["c2.android.hevc.encoder", "OMX.qcom.video.encoder.hevc", "OMX.qcom.video.encoder.avc"];
    expect(selectCodec(all, encoders)).toEqual({ codec: "h265", encoder: "OMX.qcom.video.encoder.hevc" });
  });

  test("skips codecs the device cannot encode", () => {
    expect(selectCodec(all, ["c2.android.avc.encoder"])).toEqual({ codec: "h264", encoder: "c2.android.avc.encoder" });
  });

  test("honours a definite browser false", () => {
    expect(selectCodec({ ...all, h265: false }, ["OMX.qcom.video.encoder.hevc", "OMX.qcom.video.encoder.avc"])).toEqual(
      {
        codec: "h264",
        encoder: "OMX.qcom.video.encoder.avc",
      },
    );
  });

  test("undefined browser answers are not taken as yes; falls back to h264 without encoder", () => {
    expect(
      selectCodec({ h264: undefined, h265: undefined, av1: undefined, vp8: undefined, vp9: undefined }, []),
    ).toEqual({
      codec: "h264",
    });
  });

  test("without device info picks the first browser-supported codec", () => {
    expect(selectCodec({ ...all, h265: false }, undefined)).toEqual({ codec: "h264" });
  });

  test("pickEncoder prefers hardware", () => {
    expect(pickEncoder(["c2.android.avc.encoder", "c2.exynos.h264.encoder"], "h264")).toBe("c2.exynos.h264.encoder");
    expect(pickEncoder(["c2.android.avc.encoder"], "h265")).toBeUndefined();
  });
});

describe("Annex-B helpers", () => {
  test("splitAnnexB handles 3- and 4-byte start codes", () => {
    const nalus = splitAnnexB(hex("00 00 00 01 67 AA 00 00 01 68 BB"));
    expect(nalus.map((n) => Array.from(n))).toEqual([
      [0x67, 0xaa],
      [0x68, 0xbb],
    ]);
  });
  test("stripEmulationPrevention removes 00 00 03 escapes", () => {
    expect(Array.from(stripEmulationPrevention(hex("00 00 03 01 00 00 03 00 03")))).toEqual([0, 0, 1, 0, 0, 0, 3]);
  });
});

describe("H.264", () => {
  test("parses profile/level and crop from a real SPS", () => {
    const sps = parseH264Sps(SPS_1080P);
    expect(sps.profileIdc).toBe(100);
    expect(sps.levelIdc).toBe(40);
    expect(sps.codedWidth).toBe(1920);
    expect(sps.codedHeight).toBe(1088);
    expect(sps.displayHeight).toBe(1080);
    expect(h264CodecString(sps)).toBe("avc1.640028");
  });

  test("avcC layout", () => {
    const sps = parseH264Sps(SPS_1080P);
    const avcc = buildAvcC(sps, [SPS_1080P], [PPS]);
    expect(Array.from(avcc.subarray(0, 6))).toEqual([1, 100, 0, 40, 0xff, 0xe1]);
    expect(avcc[6]! * 256 + avcc[7]!).toBe(SPS_1080P.length);
    const ppsCountAt = 8 + SPS_1080P.length;
    expect(avcc[ppsCountAt]).toBe(1);
    expect(avcc.length).toBe(ppsCountAt + 1 + 2 + PPS.length);
  });

  test("buildConfigFromPacket yields description and display size", () => {
    const packet = new Uint8Array([0, 0, 0, 1, ...SPS_1080P, 0, 0, 0, 1, ...PPS]);
    const built = buildConfigFromPacket("h264", packet, 1920, 1080);
    expect(built).not.toBeNull();
    expect(built!.config.codec).toBe("avc1.640028");
    expect(built!.config.codedHeight).toBe(1088);
    expect(built!.displayHeight).toBe(1080);
    expect(built!.config.description).toBeInstanceOf(Uint8Array);
  });

  test("vp8/vp9 never build from a packet", () => {
    expect(buildConfigFromPacket("vp9", new Uint8Array(12), 1, 1)).toBeNull();
  });
});

describe("H.265", () => {
  test("parses PTL and dimensions and builds the Annex-E codec string", () => {
    const sps = parseH265Sps(HEVC_SPS);
    expect(sps.profileIdc).toBe(1);
    expect(sps.levelIdc).toBe(93);
    expect(sps.codedWidth).toBe(1280);
    expect(sps.codedHeight).toBe(720);
    expect(h265CodecString(sps)).toBe("hev1.1.6.L93.90");
  });
});

describe("stream query", () => {
  test("merges i-frame-interval unless the user set it", () => {
    expect(buildCodecOptions(2, undefined)).toBe("i-frame-interval:int=2");
    expect(buildCodecOptions(2, "profile:int=8")).toBe("i-frame-interval:int=2,profile:int=8");
    expect(buildCodecOptions(2, "i-frame-interval:int=10")).toBe("i-frame-interval:int=10");
    expect(buildCodecOptions(undefined, undefined)).toBeUndefined();
  });

  test("maps settings to StreamQuery and drops invalid encoder names", () => {
    const q = buildStreamQuery(
      "abc123",
      { maxSize: 1280, bitrate: 4_000_000, maxFps: 30, audioEnabled: false, iFrameInterval: 2 },
      "h265",
      "bad name!",
    );
    expect(q).toEqual({
      serial: "abc123",
      videoCodec: "h265",
      audio: "false",
      maxSize: "1280",
      bitrate: "4000000",
      maxFps: "30",
      videoCodecOptions: "i-frame-interval:int=2",
    });
  });
});

describe("looksLikeNoPicture", () => {
  test("relative collapse and absolute floor", () => {
    expect(looksLikeNoPicture(13, 40000)).toBe(true);
    expect(looksLikeNoPicture(13, 0)).toBe(true);
    expect(looksLikeNoPicture(2000, 40000)).toBe(true);
    expect(looksLikeNoPicture(9000, 40000)).toBe(false);
    expect(looksLikeNoPicture(1000, 0)).toBe(false);
  });
});
