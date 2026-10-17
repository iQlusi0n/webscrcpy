import { describe, expect, test } from "bun:test";
import { SCRCPY_DEVICE_PATH, SCRCPY_SERVER_CLASS } from "@common/scrcpy.ts";
import {
  buildServerCommand,
  chooseAudioCodec,
  parseStreamQuery,
  randomScid,
  serializeServerOptions,
  type LaunchOptions,
  type StreamOptions,
} from "../../src/server/adb/options.ts";

const base: StreamOptions = {
  serial: "ABC123",
  videoCodec: "h264",
  audioCodec: "opus",
  audioSource: "output",
  audio: true,
  maxSize: 0,
  bitrate: 8_000_000,
  maxFps: 0,
  displayId: 0,
};

function launch(overrides: Partial<LaunchOptions> = {}, video: Partial<StreamOptions> = {}): LaunchOptions {
  return { scid: "0000abcd", tunnelForward: false, cleanup: true, video: { ...base, ...video }, audioCodec: "opus", ...overrides };
}

describe("parseStreamQuery", () => {
  test("rejects a missing or malformed serial", () => {
    expect(parseStreamQuery(new URLSearchParams(""))).toBeUndefined();
    expect(parseStreamQuery(new URLSearchParams("serial=-evil"))).toBeUndefined();
    expect(parseStreamQuery(new URLSearchParams("serial=a%20b"))).toBeUndefined();
  });

  test("keeps valid values and drops unsafe ones back to defaults", () => {
    const parsed = parseStreamQuery(
      new URLSearchParams(
        "serial=192.168.1.5:5555&videoCodec=h265&audioCodec=aac&audioSource=mic&audio=false&maxSize=1920&bitrate=4000000&maxFps=60&displayId=1" +
          "&videoEncoder=c2.android.avc.encoder&videoCodecOptions=i-frame-interval:int=2,profile=8",
      ),
    );
    expect(parsed).toEqual({
      serial: "192.168.1.5:5555",
      videoCodec: "h265",
      audioCodec: "aac",
      audioSource: "mic",
      audio: false,
      maxSize: 1920,
      bitrate: 4_000_000,
      maxFps: 60,
      displayId: 1,
      videoEncoder: "c2.android.avc.encoder",
      videoCodecOptions: "i-frame-interval:int=2,profile=8",
    });
    const unsafe = parseStreamQuery(
      new URLSearchParams("serial=X&videoCodec=mpeg&maxSize=-1&bitrate=1&videoEncoder=a%20b;rm&videoCodecOptions=x%20y"),
    );
    expect(unsafe).toEqual({ ...base, serial: "X" });
  });
});

describe("serializeServerOptions", () => {
  test("defaults produce only scid and log_level", () => {
    expect(serializeServerOptions(launch())).toEqual(["scid=0000abcd", "log_level=info"]);
  });

  test("emits only non-default keys", () => {
    const args = serializeServerOptions(
      launch({ audioCodec: "aac", tunnelForward: true, cleanup: false }, { videoCodec: "h265", maxSize: 1280, bitrate: 2_000_000, maxFps: 30, displayId: 2, audioSource: "mic" }),
    );
    expect(args).toEqual([
      "scid=0000abcd",
      "log_level=info",
      "video_codec=h265",
      "audio_codec=aac",
      "audio_source=mic",
      "max_size=1280",
      "video_bit_rate=2000000",
      "max_fps=30",
      "display_id=2",
      "tunnel_forward=true",
      "cleanup=false",
    ]);
  });

  test("disabled audio sets audio=false and suppresses audio keys", () => {
    const args = serializeServerOptions(launch({ audioCodec: undefined }, { audioSource: "mic" }));
    expect(args).toEqual(["scid=0000abcd", "log_level=info", "audio=false"]);
  });

  test("encoder name and codec options pass through only when allowlisted", () => {
    expect(serializeServerOptions(launch({}, { videoEncoder: "OMX.qcom.video.encoder.avc", videoCodecOptions: "profile=8" }))).toEqual([
      "scid=0000abcd",
      "log_level=info",
      "video_encoder=OMX.qcom.video.encoder.avc",
      "video_codec_options=profile=8",
    ]);
    expect(serializeServerOptions(launch({}, { videoEncoder: "bad name", videoCodecOptions: "a b" }))).toEqual(["scid=0000abcd", "log_level=info"]);
  });

  test("buildServerCommand prefixes CLASSPATH/app_process/class/version", () => {
    expect(buildServerCommand(["scid=1"])).toEqual([`CLASSPATH=${SCRCPY_DEVICE_PATH}`, "app_process", "/", SCRCPY_SERVER_CLASS, "5.0", "scid=1"]);
  });

  test("randomScid is 8 hex digits with bit 31 clear", () => {
    const scid = randomScid();
    expect(scid).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.parseInt(scid, 16) & 0x8000_0000).toBe(0);
  });
});

describe("chooseAudioCodec", () => {
  const encoders = ["OMX.google.aac.encoder", "c2.android.flac.encoder", "c2.android.avc.encoder"];

  test("keeps the request when the device has a matching encoder", () => {
    expect(chooseAudioCodec("aac", encoders)).toBe("aac");
    expect(chooseAudioCodec("flac", encoders)).toBe("flac");
  });

  test("unknown encoder list keeps the request", () => {
    expect(chooseAudioCodec("opus", [])).toBe("opus");
  });

  test("raw needs no encoder", () => {
    expect(chooseAudioCodec("raw", ["nothing.here"])).toBe("raw");
  });

  test("falls back aac → opus → flac", () => {
    expect(chooseAudioCodec("opus", encoders)).toBe("aac");
    expect(chooseAudioCodec("opus", ["c2.android.flac.encoder"])).toBe("flac");
    expect(chooseAudioCodec("aac", ["c2.android.opus.encoder"])).toBe("opus");
  });

  test("disables audio when nothing matches", () => {
    expect(chooseAudioCodec("opus", ["c2.android.avc.encoder"])).toBeUndefined();
  });
});
