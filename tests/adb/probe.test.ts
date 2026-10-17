import { describe, expect, test } from "bun:test";
import {
  parseDumpsysEncoders,
  parseScrcpyEncoderList,
  parseWmDensity,
  parseWmSize,
} from "../../src/server/adb/probe.ts";
import { isSleepWakeAction, parseScreenStateOutput } from "../../src/server/adb/routes.ts";
import { classifyKind, parseDeviceDetails, parseScreenState } from "../../src/server/adb/tracker.ts";

describe("wm parsers", () => {
  test("size and density, physical or override", () => {
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("garbage")).toBeUndefined();
    expect(parseWmDensity("Physical density: 420")).toBe(420);
    expect(parseWmDensity("")).toBeUndefined();
  });
});

describe("isSleepWakeAction", () => {
  test("accepts only the two own keys, not prototype members", () => {
    expect(isSleepWakeAction("sleep")).toBe(true);
    expect(isSleepWakeAction("wake")).toBe(true);
    for (const bad of ["constructor", "__proto__", "toString", "", 1, undefined, null, {}]) {
      expect(isSleepWakeAction(bad)).toBe(false);
    }
  });
});

describe("encoder list parsers", () => {
  test("dumpsys media.player buckets by codec substring", () => {
    const out = [
      'Encoder "c2.exynos.h264.encoder" supports',
      'Encoder "OMX.google.aac.encoder" supports',
      'Encoder "c2.android.opus.encoder" supports',
      'Encoder "c2.android.hevc.encoder" supports',
      'Encoder "c2.android.amrnb.encoder" supports',
      'Encoder "c2.android.opus.encoder" supports',
    ].join("\n");
    expect(parseDumpsysEncoders(out)).toEqual({
      video: ["c2.exynos.h264.encoder", "c2.android.hevc.encoder"],
      audio: ["OMX.google.aac.encoder", "c2.android.opus.encoder"],
    });
  });

  test("scrcpy list_encoders output", () => {
    const out = `[server] INFO: List of video encoders:
    --video-codec=h264 --video-encoder=OMX.qcom.video.encoder.avc (hw) [vendor]
    --video-codec=h265 --video-encoder=c2.qti.hevc.encoder
[server] INFO: List of audio encoders:
    --audio-codec=opus --audio-encoder=c2.android.opus.encoder (sw)`;
    expect(parseScrcpyEncoderList(out)).toEqual({
      video: ["OMX.qcom.video.encoder.avc", "c2.qti.hevc.encoder"],
      audio: ["c2.android.opus.encoder"],
    });
  });
});

describe("device details", () => {
  test("classifyKind", () => {
    expect(classifyKind("tv,default", "", "Physical size: 1920x1080", "Physical density: 320")).toBe("tv");
    expect(classifyKind("default", "true\n", "Physical size: 1920x1080", "Physical density: 320")).toBe("tv");
    expect(classifyKind("tablet", "false", "Physical size: 1600x2560", "Physical density: 320")).toBe("tablet");
    expect(classifyKind("nosdcard", "", "Physical size: 1080x2400", "Physical density: 420")).toBe("phone");
    expect(classifyKind("", "", "", "")).toBe("phone");
  });

  test("parseDeviceDetails splits the combined getprop output", () => {
    const out = [
      "Google",
      "::",
      "Pixel 8",
      "::",
      "14",
      "::",
      "34",
      "::",
      "nosdcard",
      "::",
      "false",
      "::",
      "Physical size: 1080x2400",
      "::",
      "Physical density: 420",
    ].join("\n");
    expect(parseDeviceDetails(out)).toEqual({
      manufacturer: "Google",
      model: "Pixel 8",
      androidVersion: "14",
      sdk: 34,
      kind: "phone",
    });
  });

  test("screen state parsers", () => {
    expect(parseScreenState("  mWakefulness=Awake")).toBe("awake");
    expect(parseScreenState("mWakefulness=Dozing")).toBe("asleep");
    expect(parseScreenState("")).toBe("unknown");
    expect(parseScreenStateOutput("mWakefulness=Awake\n isKeyguardShowing=true")).toEqual({
      awake: true,
      locked: true,
    });
    expect(parseScreenStateOutput("")).toEqual({ awake: true, locked: false });
    expect(parseScreenStateOutput("mWakefulness=Asleep")).toEqual({ awake: false, locked: false });
  });
});
