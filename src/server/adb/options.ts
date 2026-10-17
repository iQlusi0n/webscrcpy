/**
 * /ws/stream query → validated options → scrcpy-server argv. Pure module (unit-tested).
 * Every value that reaches `app_process` argv is allowlisted here or in @common/validate.ts.
 */
import type { AudioCodec, AudioSource, VideoCodec } from "@common/scrcpy.ts";
import { SCRCPY_DEVICE_PATH, SCRCPY_SERVER_CLASS, SCRCPY_VERSION } from "@common/scrcpy.ts";
import { isCodecOptions, isEncoderName, isSerial, parseIntInRange } from "@common/validate.ts";

export interface StreamOptions {
  serial: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  audioSource: AudioSource;
  audio: boolean;
  maxSize: number;
  bitrate: number;
  maxFps: number;
  displayId: number;
  videoEncoder?: string;
  videoCodecOptions?: string;
}

export const STREAM_DEFAULTS = {
  videoCodec: "h264" as VideoCodec,
  audioCodec: "opus" as AudioCodec,
  audioSource: "output" as AudioSource,
  audio: true,
  maxSize: 0,
  bitrate: 8_000_000,
  maxFps: 0,
  displayId: 0,
};

const VIDEO_CODEC_SET: Record<string, true> = { h264: true, h265: true, av1: true, vp8: true, vp9: true };
const AUDIO_CODEC_SET: Record<string, true> = { opus: true, aac: true, flac: true, raw: true };
const AUDIO_SOURCE_SET: Record<string, true> = { output: true, mic: true, playback: true };

/** Unsafe or out-of-range values fall back to defaults; only an invalid serial rejects. */
export function parseStreamQuery(params: URLSearchParams): StreamOptions | undefined {
  const serial = params.get("serial");
  if (!isSerial(serial)) return undefined;
  const videoCodec = params.get("videoCodec");
  const audioCodec = params.get("audioCodec");
  const audioSource = params.get("audioSource");
  const videoEncoder = params.get("videoEncoder");
  const videoCodecOptions = params.get("videoCodecOptions");
  const options: StreamOptions = {
    serial,
    videoCodec:
      videoCodec !== null && VIDEO_CODEC_SET[videoCodec] ? (videoCodec as VideoCodec) : STREAM_DEFAULTS.videoCodec,
    audioCodec:
      audioCodec !== null && AUDIO_CODEC_SET[audioCodec] ? (audioCodec as AudioCodec) : STREAM_DEFAULTS.audioCodec,
    audioSource:
      audioSource !== null && AUDIO_SOURCE_SET[audioSource]
        ? (audioSource as AudioSource)
        : STREAM_DEFAULTS.audioSource,
    audio: params.get("audio") !== "false",
    maxSize: parseIntInRange(params.get("maxSize") ?? undefined, 0, 7680) ?? STREAM_DEFAULTS.maxSize,
    bitrate: parseIntInRange(params.get("bitrate") ?? undefined, 100_000, 200_000_000) ?? STREAM_DEFAULTS.bitrate,
    maxFps: parseIntInRange(params.get("maxFps") ?? undefined, 0, 240) ?? STREAM_DEFAULTS.maxFps,
    displayId: parseIntInRange(params.get("displayId") ?? undefined, 0, 1_000_000) ?? STREAM_DEFAULTS.displayId,
  };
  if (isEncoderName(videoEncoder)) options.videoEncoder = videoEncoder;
  if (isCodecOptions(videoCodecOptions)) options.videoCodecOptions = videoCodecOptions;
  return options;
}

/** What actually gets launched after SDK gates and codec fallback. */
export interface LaunchOptions {
  /** 8 hex digits */
  scid: string;
  tunnelForward: boolean;
  cleanup: boolean;
  video: StreamOptions;
  /** undefined → audio=false */
  audioCodec: AudioCodec | undefined;
}

/** `key=value` list for app_process: only non-default options, plus scid and log_level. */
export function serializeServerOptions(launch: LaunchOptions): string[] {
  const { video, audioCodec } = launch;
  const args = [`scid=${launch.scid}`, "log_level=info"];
  if (audioCodec === undefined) args.push("audio=false");
  if (video.videoCodec !== STREAM_DEFAULTS.videoCodec) args.push(`video_codec=${video.videoCodec}`);
  if (audioCodec !== undefined && audioCodec !== STREAM_DEFAULTS.audioCodec) args.push(`audio_codec=${audioCodec}`);
  if (audioCodec !== undefined && video.audioSource !== STREAM_DEFAULTS.audioSource)
    args.push(`audio_source=${video.audioSource}`);
  if (video.maxSize !== STREAM_DEFAULTS.maxSize) args.push(`max_size=${video.maxSize}`);
  if (video.bitrate !== STREAM_DEFAULTS.bitrate) args.push(`video_bit_rate=${video.bitrate}`);
  if (video.maxFps !== STREAM_DEFAULTS.maxFps) args.push(`max_fps=${video.maxFps}`);
  if (video.displayId !== STREAM_DEFAULTS.displayId) args.push(`display_id=${video.displayId}`);
  if (video.videoEncoder !== undefined && isEncoderName(video.videoEncoder))
    args.push(`video_encoder=${video.videoEncoder}`);
  if (video.videoCodecOptions !== undefined && isCodecOptions(video.videoCodecOptions)) {
    args.push(`video_codec_options=${video.videoCodecOptions}`);
  }
  if (launch.tunnelForward) args.push("tunnel_forward=true");
  if (!launch.cleanup) args.push("cleanup=false");
  return args;
}

/** Full argv for `adb shell`: Tango joins with spaces, every piece is allowlisted above. */
export function buildServerCommand(options: string[]): string[] {
  return [`CLASSPATH=${SCRCPY_DEVICE_PATH}`, "app_process", "/", SCRCPY_SERVER_CLASS, SCRCPY_VERSION, ...options];
}

const AUDIO_FALLBACK_ORDER: AudioCodec[] = ["aac", "opus", "flac"];

/**
 * Pick an audio codec the device can encode. `encoders` are MediaCodec encoder names from
 * the probe; an empty list means "unknown", so the request is kept. `raw` needs no encoder.
 * Returns undefined when nothing matches (audio must be disabled).
 */
export function chooseAudioCodec(requested: AudioCodec, encoders: readonly string[]): AudioCodec | undefined {
  if (requested === "raw" || encoders.length === 0) return requested;
  const lower = encoders.map((name) => name.toLowerCase());
  const supports = (codec: AudioCodec): boolean => lower.some((name) => name.includes(`.${codec}.`));
  if (supports(requested)) return requested;
  return AUDIO_FALLBACK_ORDER.find((codec) => codec !== requested && supports(codec));
}

/** Random 31-bit scid as 8 lowercase hex digits (socket name `scrcpy_<scid>`). */
export function randomScid(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return ((bytes[0] ?? 0) & 0x7fff_ffff).toString(16).padStart(8, "0");
}
