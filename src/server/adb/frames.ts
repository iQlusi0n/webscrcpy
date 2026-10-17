/**
 * scrcpy media-socket framing (SCRCPY_PROTOCOL.md §3). Pure parsing lives here so it can be
 * unit-tested; `SocketReader` is the thin exact-read cursor over an AdbSocket.
 */
import { BufferedReadableStream, type ReadableStream as TangoReadableStream } from "@yume-chan/stream-extra";
import type { AdbSocket } from "@yume-chan/adb";
import { FRAME_HEADER_SIZE, PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME, PTS_MASK } from "@common/scrcpy.ts";

export type FrameHeader =
  | { kind: "session"; flags: number; width: number }
  | { kind: "media"; config: boolean; keyframe: boolean; pts: bigint };

/** Classify the first 8 bytes of a packet: session marker (bit 63) or media ptsAndFlags. */
export function parseFrameHeader(head: Uint8Array): FrameHeader {
  if (head.byteLength < 8) throw new RangeError(`frame header needs 8 bytes, got ${head.byteLength}`);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const flagsHigh = view.getUint32(0);
  if ((flagsHigh & 0x8000_0000) !== 0) {
    return { kind: "session", flags: flagsHigh & 0x7fff_ffff, width: view.getUint32(4) };
  }
  const ptsAndFlags = view.getBigUint64(0);
  return {
    kind: "media",
    config: (ptsAndFlags & PTS_FLAG_CONFIG) !== 0n,
    keyframe: (ptsAndFlags & PTS_FLAG_KEYFRAME) !== 0n,
    pts: ptsAndFlags & PTS_MASK,
  };
}

/** `[1B channel][8B ptsAndFlags][4B size][payload]` — header bytes copied verbatim. */
export function buildMediaFrame(channel: number, head: Uint8Array, size: Uint8Array, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + FRAME_HEADER_SIZE + payload.byteLength);
  frame[0] = channel;
  frame.set(head, 1);
  frame.set(size, 9);
  frame.set(payload, 1 + FRAME_HEADER_SIZE);
  return frame;
}

export function buildJsonFrame(channel: number, value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = channel;
  frame.set(body, 1);
  return frame;
}

export function readU32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

/** Exact-length reads over an AdbSocket's readable side. */
export class SocketReader {
  private readonly buffered: BufferedReadableStream;

  constructor(readonly socket: AdbSocket) {
    this.buffered = new BufferedReadableStream(socket.readable);
  }

  async read(length: number): Promise<Uint8Array> {
    return await this.buffered.readExactly(length);
  }

  async cancel(): Promise<void> {
    await this.buffered.cancel().catch(() => undefined);
  }

  /** Unconsumed bytes plus the rest of the socket as a fresh stream. */
  release(): TangoReadableStream<Uint8Array> {
    return this.buffered.release();
  }
}

/** Decode the 64-byte zero-padded UTF-8 device name field. */
export function decodeDeviceName(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end === -1) end = field.byteLength;
  return new TextDecoder().decode(field.subarray(0, end));
}
