/**
 * WebCodecs support probing, codec selection and VideoDecoderConfig builders.
 * H.264/H.265 config packets arrive as Annex-B parameter sets and must become avcC/hvcC
 * `description` boxes; AV1 ships its sequence header OBU; VP8/VP9 are configured from metadata.
 * Pure module (no DOM) except `probeDecodeSupport`.
 */
import type { VideoCodec } from "@common/scrcpy.ts";

export const CODEC_PROBE_STRINGS: Record<VideoCodec, readonly string[]> = {
  h264: ["avc1.42E01E", "avc1.4D401E", "avc1.640028"],
  h265: ["hev1.1.6.L93.B0"],
  av1: ["av01.0.04M.08"],
  vp8: ["vp8"],
  vp9: ["vp09.00.10.08"],
};

/** true/false from `VideoDecoder.isConfigSupported`; undefined when no answer was obtainable. */
export async function probeDecodeSupport(codec: VideoCodec): Promise<boolean | undefined> {
  if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") return undefined;
  let answered = false;
  for (const codecString of CODEC_PROBE_STRINGS[codec]) {
    try {
      const result = await VideoDecoder.isConfigSupported({ codec: codecString });
      answered = true;
      if (result.supported) return true;
    } catch {
      // malformed/unimplemented string: not an answer
    }
  }
  return answered ? false : undefined;
}

export const CODEC_PREFERENCE: readonly VideoCodec[] = ["h265", "h264", "av1", "vp8", "vp9"];
export const FALLBACK_CODEC: VideoCodec = "h264";

const CONFIGLESS_CODECS: Record<string, true> = { vp8: true, vp9: true };
export function isConfiglessCodec(codec: VideoCodec): boolean {
  return CONFIGLESS_CODECS[codec] === true;
}

/** Codec token as it appears in MediaCodec names: `c2.qcom.hevc.encoder`, `OMX.qcom.video.encoder.hevc`, `OMX.google.h264.encoder`. */
const ENCODER_NAME_PATTERNS: Record<VideoCodec, readonly RegExp[]> = {
  h264: [/(^|[./])(avc|h264)([./]|$)/],
  h265: [/(^|[./])(hevc|h265)([./]|$)/],
  av1: [/(^|[./])av(1|01)([./]|$)/],
  vp8: [/(^|[./])(vp8|x-vnd\.on2\.vp8)([./]|$)/],
  vp9: [/(^|[./])(vp9|x-vnd\.on2\.vp9)([./]|$)/],
};
const SOFTWARE_ENCODER_RE = /(^|\.)c2\.android\.|^omx\.google\./i;
/** Android's own software encoders; anything else is treated as vendor silicon. */
export function isSoftwareEncoder(encoderName: string): boolean {
  return SOFTWARE_ENCODER_RE.test(encoderName);
}

export function encoderMatchesCodec(encoderName: string, codec: VideoCodec): boolean {
  const lower = encoderName.toLowerCase();
  return ENCODER_NAME_PATTERNS[codec].some((p) => p.test(lower));
}

/** Best encoder name for `codec`: hardware if offered, else the first software one, else none. */
export function pickEncoder(encoders: readonly string[], codec: VideoCodec): string | undefined {
  const matching = encoders.filter((e) => encoderMatchesCodec(e, codec));
  return matching.find((e) => !SOFTWARE_ENCODER_RE.test(e)) ?? matching[0];
}

export interface CodecChoice {
  codec: VideoCodec;
  encoder?: string;
}

/**
 * First codec in preference order that the browser can decode (`true`) and — when device
 * encoders are known — the device can encode. Falls back to h264 without an encoder.
 */
export function selectCodec(
  browserSupport: Readonly<Record<VideoCodec, boolean | undefined>>,
  deviceEncoders: readonly string[] | undefined,
): CodecChoice {
  for (const codec of CODEC_PREFERENCE) {
    if (browserSupport[codec] !== true) continue;
    if (deviceEncoders === undefined) return { codec };
    const encoder = pickEncoder(deviceEncoders, codec);
    if (encoder !== undefined) return { codec, encoder };
  }
  return { codec: FALLBACK_CODEC };
}

// ---------------------------------------------------------------- bitstream helpers

export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) nalus.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nalus.push(data.subarray(start));
  return nalus;
}

/**
 * Re-frame an Annex-B access unit as length-prefixed NAL units (u32 BE per NAL), the layout a
 * decoder configured with an avcC/hvcC `description` expects. Trailing zero bytes (before each
 * start code and at the end of the unit) are dropped. Returns `data` unchanged without start codes.
 */
export function annexBToLengthPrefixed(data: Uint8Array): Uint8Array {
  const nalus = splitAnnexB(data);
  const tail = nalus[nalus.length - 1];
  if (!tail) return data;
  let end = tail.length;
  while (end > 0 && tail[end - 1] === 0) end--;
  nalus[nalus.length - 1] = tail.subarray(0, end);
  let total = 0;
  for (const nal of nalus) total += 4 + nal.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const nal of nalus) {
    view.setUint32(off, nal.length, false);
    out.set(nal, off + 4);
    off += 4 + nal.length;
  }
  return out;
}

export function stripEmulationPrevention(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i] ?? 0;
    if (zeros >= 2 && b === 3 && i + 1 < nal.length && (nal[i + 1] ?? 0) <= 3) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

export class BitReader {
  private pos = 0;
  constructor(
    private readonly data: Uint8Array,
    startByte = 0,
  ) {
    this.pos = startByte * 8;
  }
  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new RangeError("bitstream overrun");
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  /** unsigned Exp-Golomb */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new RangeError("bad exp-golomb");
    }
    return (1 << zeros) - 1 + this.bits(zeros);
  }
  /** signed Exp-Golomb */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
  /** AV1 uvlc */
  uvlc(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros >= 32) return 0xffffffff;
    }
    return (1 << zeros) - 1 + this.bits(zeros);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ---------------------------------------------------------------- H.264

export interface H264Sps {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
}

const H264_NAL_SPS = 7;
const H264_NAL_PPS = 8;
const HIGH_PROFILES: Record<number, true> = {
  100: true,
  110: true,
  122: true,
  244: true,
  44: true,
  83: true,
  86: true,
  118: true,
  128: true,
  138: true,
  139: true,
  134: true,
  135: true,
};

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parse an H.264 SPS NAL (with its 1-byte header, emulation bytes present). */
export function parseH264Sps(nal: Uint8Array): H264Sps {
  const r = new BitReader(stripEmulationPrevention(nal), 1);
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  if (HIGH_PROFILES[profileIdc]) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.skip(1);
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.skip(1); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.skip(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.skip(1);
  r.skip(1); // direct_8x8_inference_flag
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.bit()) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }
  const codedWidth = widthMbs * 16;
  const codedHeight = (2 - frameMbsOnly) * heightMapUnits * 16;
  const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);
  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    codedWidth,
    codedHeight,
    displayWidth: codedWidth - cropUnitX * (cropLeft + cropRight),
    displayHeight: codedHeight - cropUnitY * (cropTop + cropBottom),
  };
}

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}

export function h264CodecString(sps: H264Sps): string {
  return `avc1.${hex2(sps.profileIdc)}${hex2(sps.constraintFlags)}${hex2(sps.levelIdc)}`;
}

/** AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1). */
export function buildAvcC(sps: H264Sps, spsNalus: Uint8Array[], ppsNalus: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [
    Uint8Array.of(1, sps.profileIdc, sps.constraintFlags, sps.levelIdc, 0xff, 0xe0 | (spsNalus.length & 0x1f)),
  ];
  for (const n of spsNalus) chunks.push(Uint8Array.of(n.length >> 8, n.length & 0xff), n);
  chunks.push(Uint8Array.of(ppsNalus.length));
  for (const n of ppsNalus) chunks.push(Uint8Array.of(n.length >> 8, n.length & 0xff), n);
  return concat(chunks);
}

// ---------------------------------------------------------------- H.265

export interface H265Sps {
  profileSpace: number;
  tierFlag: number;
  profileIdc: number;
  /** general_profile_compatibility_flags, 32 bits, bit 31 = flag[0] */
  compatFlags: number;
  /** general_constraint_indicator_flags, 6 bytes */
  constraintBytes: Uint8Array;
  levelIdc: number;
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
}

const HEVC_NAL_VPS = 32;
const HEVC_NAL_SPS = 33;
const HEVC_NAL_PPS = 34;

/** Parse an H.265 SPS NAL (2-byte header, emulation bytes present). */
export function parseH265Sps(nal: Uint8Array): H265Sps {
  const r = new BitReader(stripEmulationPrevention(nal), 2);
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  r.skip(1); // sps_temporal_id_nesting_flag
  // profile_tier_level(1, maxSubLayersMinus1)
  const profileSpace = r.bits(2);
  const tierFlag = r.bit();
  const profileIdc = r.bits(5);
  const compatFlags = r.bits(32) >>> 0;
  const constraintBytes = new Uint8Array(6);
  for (let i = 0; i < 6; i++) constraintBytes[i] = r.bits(8);
  const levelIdc = r.bits(8);
  const subProfilePresent: number[] = [];
  const subLevelPresent: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfilePresent.push(r.bit());
    subLevelPresent.push(r.bit());
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfilePresent[i]) r.skip(88);
    if (subLevelPresent[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.skip(1);
  const codedWidth = r.ue();
  const codedHeight = r.ue();
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  if (r.bit()) {
    left = r.ue();
    right = r.ue();
    top = r.ue();
    bottom = r.ue();
  }
  const bitDepthLumaMinus8 = r.ue();
  const bitDepthChromaMinus8 = r.ue();
  const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatFlags,
    constraintBytes,
    levelIdc,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    codedWidth,
    codedHeight,
    displayWidth: codedWidth - subWidthC * (left + right),
    displayHeight: codedHeight - subHeightC * (top + bottom),
  };
}

function reverseBits32(v: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | ((v >>> i) & 1);
  }
  return r >>> 0;
}

/** ISO/IEC 14496-15 Annex E codec string, e.g. hev1.1.6.L93.B0 */
export function h265CodecString(sps: H265Sps): string {
  const space = ["", "A", "B", "C"][sps.profileSpace] ?? "";
  const compat = reverseBits32(sps.compatFlags).toString(16).toUpperCase();
  const tier = sps.tierFlag ? "H" : "L";
  let lastNonZero = 0;
  for (let i = 0; i < 6; i++) if (sps.constraintBytes[i] !== 0) lastNonZero = i;
  const constraints: string[] = [];
  for (let i = 0; i <= lastNonZero; i++) constraints.push(hex2(sps.constraintBytes[i] ?? 0));
  return `hev1.${space}${sps.profileIdc}.${compat}.${tier}${sps.levelIdc}.${constraints.join(".")}`;
}

/** HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1). */
export function buildHvcC(sps: H265Sps, vps: Uint8Array[], spsNalus: Uint8Array[], pps: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [
    Uint8Array.of(
      1,
      (sps.profileSpace << 6) | (sps.tierFlag << 5) | sps.profileIdc,
      (sps.compatFlags >>> 24) & 0xff,
      (sps.compatFlags >>> 16) & 0xff,
      (sps.compatFlags >>> 8) & 0xff,
      sps.compatFlags & 0xff,
    ),
    sps.constraintBytes,
    Uint8Array.of(
      sps.levelIdc,
      0xf0, // reserved + min_spatial_segmentation_idc (0)
      0x00,
      0xfc, // reserved + parallelismType (0)
      0xfc | (sps.chromaFormatIdc & 3),
      0xf8 | (sps.bitDepthLumaMinus8 & 7),
      0xf8 | (sps.bitDepthChromaMinus8 & 7),
      0x00, // avgFrameRate
      0x00,
      0x0b, // constantFrameRate(0) numTemporalLayers(1) temporalIdNested(0) lengthSizeMinusOne(3)
      3, // numOfArrays
    ),
  ];
  const pushArray = (type: number, nalus: Uint8Array[]): void => {
    chunks.push(Uint8Array.of(0x80 | type, nalus.length >> 8, nalus.length & 0xff));
    for (const n of nalus) chunks.push(Uint8Array.of(n.length >> 8, n.length & 0xff), n);
  };
  pushArray(HEVC_NAL_VPS, vps);
  pushArray(HEVC_NAL_SPS, spsNalus);
  pushArray(HEVC_NAL_PPS, pps);
  return concat(chunks);
}

// ---------------------------------------------------------------- AV1

export interface Av1SequenceInfo {
  profile: number;
  levelIdx: number;
  tier: number;
  bitDepth: number;
  monochrome: number;
  subsamplingX: number;
  subsamplingY: number;
  chromaSamplePosition: number;
  maxWidth: number;
  maxHeight: number;
}

const OBU_SEQUENCE_HEADER = 1;

function readLeb128(data: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = data[pos + i];
    if (b === undefined) throw new RangeError("leb128 overrun");
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value: value >>> 0, next: pos + i + 1 };
  }
  throw new RangeError("leb128 too long");
}

/** Locate the sequence header OBU (including its header) inside a buffer of OBUs. */
export function findSequenceHeaderObu(data: Uint8Array): Uint8Array | null {
  let pos = 0;
  while (pos < data.length) {
    const start = pos;
    const header = data[pos++] ?? 0;
    if ((header & 0x80) !== 0) return null; // forbidden bit
    const type = (header >> 3) & 0xf;
    const hasExtension = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    if (hasExtension) pos++;
    let size: number;
    if (hasSize) {
      const leb = readLeb128(data, pos);
      size = leb.value;
      pos = leb.next;
    } else {
      size = data.length - pos;
    }
    const end = pos + size;
    if (end > data.length) return null;
    if (type === OBU_SEQUENCE_HEADER) return data.subarray(start, end);
    pos = end;
  }
  return null;
}

/** Parse an AV1 sequence header OBU (with its OBU header). */
export function parseAv1SequenceHeader(obu: Uint8Array): Av1SequenceInfo {
  let pos = 1;
  const header = obu[0] ?? 0;
  if ((header >> 2) & 1) pos++;
  if ((header >> 1) & 1) pos = readLeb128(obu, pos).next;
  const r = new BitReader(obu, pos);
  const profile = r.bits(3);
  r.skip(1); // still_picture
  const reduced = r.bit();
  let levelIdx = 0;
  let tier = 0;
  let decoderModelInfoPresent = 0;
  let bufferDelayLengthMinus1 = 0;
  if (reduced) {
    levelIdx = r.bits(5);
  } else {
    if (r.bit()) {
      // timing_info
      r.skip(32);
      r.skip(32);
      if (r.bit()) r.uvlc();
      decoderModelInfoPresent = r.bit();
      if (decoderModelInfoPresent) {
        bufferDelayLengthMinus1 = r.bits(5);
        r.skip(32);
        r.skip(5);
        r.skip(5);
      }
    }
    const initialDisplayDelayPresent = r.bit();
    const opCount = r.bits(5) + 1;
    for (let i = 0; i < opCount; i++) {
      r.skip(12); // operating_point_idc
      const level = r.bits(5);
      let opTier = 0;
      if (level > 7) opTier = r.bit();
      if (i === 0) {
        levelIdx = level;
        tier = opTier;
      }
      if (decoderModelInfoPresent && r.bit()) {
        const n = bufferDelayLengthMinus1 + 1;
        r.skip(n);
        r.skip(n);
        r.skip(1);
      }
      if (initialDisplayDelayPresent && r.bit()) r.skip(4);
    }
  }
  const wBits = r.bits(4) + 1;
  const hBits = r.bits(4) + 1;
  const maxWidth = r.bits(wBits) + 1;
  const maxHeight = r.bits(hBits) + 1;
  if (!reduced && r.bit()) r.skip(7); // frame_id_numbers_present → delta(4)+additional(3)
  r.skip(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  let enableOrderHint = 0;
  if (!reduced) {
    r.skip(4); // interintra_compound, masked_compound, warped_motion, dual_filter
    enableOrderHint = r.bit();
    if (enableOrderHint) r.skip(2); // jnt_comp, ref_frame_mvs
    const screenContentTools = r.bit() ? 2 : r.bit();
    if (screenContentTools > 0) {
      if (!r.bit()) r.skip(1); // seq_choose_integer_mv ? : seq_force_integer_mv
    }
    if (enableOrderHint) r.skip(3);
  }
  r.skip(3); // enable_superres, enable_cdef, enable_restoration
  // color_config
  const highBitDepth = r.bit();
  let bitDepth = 8;
  if (profile === 2 && highBitDepth) {
    bitDepth = r.bit() ? 12 : 10;
  } else if (highBitDepth) {
    bitDepth = 10;
  }
  const monochrome = profile === 1 ? 0 : r.bit();
  let cp = 2;
  let tc = 2;
  let mc = 2;
  if (r.bit()) {
    cp = r.bits(8);
    tc = r.bits(8);
    mc = r.bits(8);
  }
  let subsamplingX = 1;
  let subsamplingY = 1;
  let chromaSamplePosition = 0;
  if (monochrome) {
    r.skip(1); // color_range
  } else if (cp === 1 && tc === 13 && mc === 0) {
    subsamplingX = 0;
    subsamplingY = 0;
  } else {
    r.skip(1); // color_range
    if (profile === 0) {
      subsamplingX = 1;
      subsamplingY = 1;
    } else if (profile === 1) {
      subsamplingX = 0;
      subsamplingY = 0;
    } else if (bitDepth === 12) {
      subsamplingX = r.bit();
      subsamplingY = subsamplingX ? r.bit() : 0;
    } else {
      subsamplingX = 1;
      subsamplingY = 0;
    }
    if (subsamplingX && subsamplingY) chromaSamplePosition = r.bits(2);
  }
  return {
    profile,
    levelIdx,
    tier,
    bitDepth,
    monochrome,
    subsamplingX,
    subsamplingY,
    chromaSamplePosition,
    maxWidth,
    maxHeight,
  };
}

export function av1CodecString(info: Av1SequenceInfo): string {
  const level = String(info.levelIdx).padStart(2, "0");
  const tier = info.tier ? "H" : "M";
  const depth = String(info.bitDepth).padStart(2, "0");
  return `av01.${info.profile}.${level}${tier}.${depth}`;
}

/** AV1CodecConfigurationRecord (av1C) with the sequence header as configOBUs. */
export function buildAv1C(info: Av1SequenceInfo, sequenceHeaderObu: Uint8Array): Uint8Array {
  const highBitDepth = info.bitDepth > 8 ? 1 : 0;
  const twelveBit = info.bitDepth === 12 ? 1 : 0;
  const head = Uint8Array.of(
    0x81,
    (info.profile << 5) | info.levelIdx,
    (info.tier << 7) |
      (highBitDepth << 6) |
      (twelveBit << 5) |
      (info.monochrome << 4) |
      (info.subsamplingX << 3) |
      (info.subsamplingY << 2) |
      info.chromaSamplePosition,
    0x00,
  );
  return concat([head, sequenceHeaderObu]);
}

// ---------------------------------------------------------------- VideoDecoderConfig

export interface DecoderConfig {
  config: VideoDecoderConfig;
  /** display (cropped) size the SPS advertises, when parsed */
  displayWidth?: number;
  displayHeight?: number;
}

/** Decoder config for codecs that carry no usable config packet (VP8/VP9). */
export function buildConfiglessConfig(codec: VideoCodec, width: number, height: number): VideoDecoderConfig {
  return {
    codec: CODEC_PROBE_STRINGS[codec][0] ?? codec,
    codedWidth: width,
    codedHeight: height,
    optimizeForLatency: true,
  };
}

/**
 * Decoder config from a scrcpy config packet. Returns null when the packet carries nothing
 * usable (not parameter sets); VP8/VP9 always return null — use `buildConfiglessConfig`.
 */
export function buildConfigFromPacket(
  codec: VideoCodec,
  packet: Uint8Array,
  sessionWidth: number,
  sessionHeight: number,
): DecoderConfig | null {
  switch (codec) {
    case "h264": {
      const nalus = splitAnnexB(packet);
      const sps = nalus.filter((n) => ((n[0] ?? 0) & 0x1f) === H264_NAL_SPS);
      const pps = nalus.filter((n) => ((n[0] ?? 0) & 0x1f) === H264_NAL_PPS);
      const firstSps = sps[0];
      if (firstSps === undefined || pps.length === 0) return null;
      const info = parseH264Sps(firstSps);
      return {
        config: {
          codec: h264CodecString(info),
          codedWidth: info.codedWidth,
          codedHeight: info.codedHeight,
          description: buildAvcC(info, sps, pps),
          optimizeForLatency: true,
        },
        displayWidth: info.displayWidth,
        displayHeight: info.displayHeight,
      };
    }
    case "h265": {
      const nalus = splitAnnexB(packet);
      const vps = nalus.filter((n) => (((n[0] ?? 0) >> 1) & 0x3f) === HEVC_NAL_VPS);
      const sps = nalus.filter((n) => (((n[0] ?? 0) >> 1) & 0x3f) === HEVC_NAL_SPS);
      const pps = nalus.filter((n) => (((n[0] ?? 0) >> 1) & 0x3f) === HEVC_NAL_PPS);
      const firstSps = sps[0];
      if (vps.length === 0 || firstSps === undefined || pps.length === 0) return null;
      const info = parseH265Sps(firstSps);
      return {
        config: {
          codec: h265CodecString(info),
          codedWidth: info.codedWidth,
          codedHeight: info.codedHeight,
          description: buildHvcC(info, vps, sps, pps),
          optimizeForLatency: true,
        },
        displayWidth: info.displayWidth,
        displayHeight: info.displayHeight,
      };
    }
    case "av1": {
      const obu = findSequenceHeaderObu(packet);
      if (!obu) return null;
      const info = parseAv1SequenceHeader(obu);
      return {
        config: {
          codec: av1CodecString(info),
          codedWidth: sessionWidth,
          codedHeight: sessionHeight,
          description: buildAv1C(info, obu),
          optimizeForLatency: true,
        },
      };
    }
    case "vp8":
    case "vp9":
      return null;
  }
}
