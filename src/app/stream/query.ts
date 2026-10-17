/** Pure helpers behind startStream: settings → StreamQuery, codec-options merge, no-picture test. */
import type { DeviceStreamSettings } from "@common/api.ts";
import type { StreamQuery } from "@common/protocol.ts";
import type { VideoCodec } from "@common/scrcpy.ts";
import { isCodecOptions, isEncoderName } from "@common/validate.ts";

export const NO_PICTURE_FLOOR_BYTES = 1000;

export function buildStreamQuery(
  serial: string,
  settings: DeviceStreamSettings,
  codec: VideoCodec | undefined,
  encoder: string | undefined,
): StreamQuery {
  const query: StreamQuery = { serial };
  if (codec) query.videoCodec = codec;
  if (encoder && isEncoderName(encoder)) query.videoEncoder = encoder;
  if (settings.audioEnabled !== undefined) query.audio = settings.audioEnabled ? "true" : "false";
  if (settings.audioCodec) query.audioCodec = settings.audioCodec;
  if (settings.audioSource) query.audioSource = settings.audioSource;
  if (settings.maxSize) query.maxSize = String(settings.maxSize);
  if (settings.bitrate) query.bitrate = String(settings.bitrate);
  if (settings.maxFps) query.maxFps = String(settings.maxFps);
  if (settings.displayId !== undefined) query.displayId = String(settings.displayId);
  const options = buildCodecOptions(settings.iFrameInterval, settings.codecOptions);
  if (options && isCodecOptions(options)) query.videoCodecOptions = options;
  return query;
}

/** Merge the i-frame interval into user codec options unless the user already set the key. */
export function buildCodecOptions(
  iFrameInterval: number | undefined,
  userOptions: string | undefined,
): string | undefined {
  const user = userOptions?.trim() ?? "";
  const userHasKey = user.split(",").some((part) => part.split(/[:=]/)[0] === "i-frame-interval");
  if (!iFrameInterval || userHasKey) return user || undefined;
  const interval = `i-frame-interval:int=${Math.round(iFrameInterval)}`;
  return user ? `${interval},${user}` : interval;
}

/** Rolling average collapsed below 10% of its peak, or under the absolute floor. */
export function looksLikeNoPicture(averageBytes: number, baselineBytes: number): boolean {
  return (baselineBytes > 0 && averageBytes < baselineBytes * 0.1) || averageBytes < NO_PICTURE_FLOOR_BYTES;
}
