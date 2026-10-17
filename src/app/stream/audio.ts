/**
 * Audio playback: AudioDecoder (opus/aac/flac) or raw S16LE → float32 planar frames pushed to an
 * AudioWorklet ring buffer. 48 kHz stereo, interactive latency. Playback starts on the first user
 * gesture if the context was created suspended.
 */
import type { AudioCodec } from "@common/scrcpy.ts";
import type { MediaPacket } from "./demuxer.ts";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
/** worklet ring capacity; beyond this the oldest samples are discarded */
const RING_FRAMES = SAMPLE_RATE / 2;
/** when more than this is queued, skip ahead to bound latency */
const MAX_QUEUED_FRAMES = SAMPLE_RATE / 5;

const WORKLET_SOURCE = `
class RingPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = ${RING_FRAMES};
    this.max = ${MAX_QUEUED_FRAMES};
    this.buf = [new Float32Array(this.cap), new Float32Array(this.cap)];
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.port.onmessage = (e) => this.enqueue(e.data);
  }
  enqueue(planes) {
    const n = planes[0].length;
    if (this.size + n > this.cap) {
      const drop = this.size + n - this.cap;
      this.read = (this.read + drop) % this.cap;
      this.size -= drop;
    }
    for (let c = 0; c < 2; c++) {
      const src = planes[Math.min(c, planes.length - 1)];
      const dst = this.buf[c];
      const first = Math.min(n, this.cap - this.write);
      dst.set(src.subarray(0, first), this.write);
      if (first < n) dst.set(src.subarray(first), 0);
    }
    this.write = (this.write + n) % this.cap;
    this.size += n;
    if (this.size > this.max) {
      const drop = this.size - this.max;
      this.read = (this.read + drop) % this.cap;
      this.size -= drop;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length;
    const avail = Math.min(frames, this.size);
    for (let c = 0; c < out.length; c++) {
      const dst = out[c];
      const src = this.buf[Math.min(c, 1)];
      let r = this.read;
      for (let i = 0; i < avail; i++) {
        dst[i] = src[r];
        r = r + 1 === this.cap ? 0 : r + 1;
      }
      for (let i = avail; i < frames; i++) dst[i] = 0;
    }
    this.read = (this.read + avail) % this.cap;
    this.size -= avail;
    return true;
  }
}
registerProcessor("ring-player", RingPlayer);
`;

const FLAC_STREAMINFO_LENGTH = 34;

export class AudioPlayer {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private decoder: AudioDecoder | null = null;
  private codec: AudioCodec | null = null;
  private configured = false;
  private stopped = false;
  private readonly early: MediaPacket[] = [];
  private readonly gestureListener = (): void => {
    void this.context?.resume();
  };

  /** Resolves once the worklet is loaded; packets pushed before that are queued. */
  async start(codec: AudioCodec): Promise<void> {
    this.codec = codec;
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this.context = context;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (this.stopped) {
      await context.close();
      return;
    }
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.node = new AudioWorkletNode(context, "ring-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
    });
    this.node.connect(this.gain);
    if (context.state !== "running") {
      void context.resume();
      document.addEventListener("pointerdown", this.gestureListener, { capture: true });
      document.addEventListener("keydown", this.gestureListener, { capture: true });
    }
    if (codec !== "raw") {
      this.decoder = new AudioDecoder({
        output: (data) => this.onDecoded(data),
        error: (err) => console.warn("[audio] decoder error", err),
      });
      if (codec === "opus") this.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
    } else {
      this.configured = true;
    }
    for (const packet of this.early.splice(0)) this.push(packet);
  }

  push(packet: MediaPacket): void {
    if (this.stopped || !this.codec) return;
    if (!this.node) {
      this.early.push(packet);
      return;
    }
    if (this.codec === "raw") {
      this.postPlanes(s16leToPlanar(packet.data));
      return;
    }
    if (packet.isConfig) {
      if (this.codec === "aac") {
        this.configure({
          codec: "mp4a.40.2",
          sampleRate: SAMPLE_RATE,
          numberOfChannels: CHANNELS,
          description: packet.data,
        });
      } else if (this.codec === "flac") {
        this.configure({
          codec: "flac",
          sampleRate: SAMPLE_RATE,
          numberOfChannels: CHANNELS,
          description: flacDescription(packet.data),
        });
      }
      return;
    }
    if (!this.configured || !this.decoder || this.decoder.state !== "configured") return;
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(packet.pts), data: packet.data }));
    } catch (err) {
      console.warn("[audio] decode threw", err);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener("pointerdown", this.gestureListener, { capture: true });
    document.removeEventListener("keydown", this.gestureListener, { capture: true });
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.node?.disconnect();
    this.gain?.disconnect();
    this.node = null;
    this.gain = null;
    if (this.context && this.context.state !== "closed") void this.context.close();
    this.context = null;
    this.early.length = 0;
  }

  private configure(config: AudioDecoderConfig): void {
    if (!this.decoder) return;
    try {
      this.decoder.configure(config);
      this.configured = true;
    } catch (err) {
      console.warn("[audio] configure failed", err);
    }
  }

  private onDecoded(data: AudioData): void {
    try {
      const planes: Float32Array[] = [];
      const count = Math.min(data.numberOfChannels, CHANNELS);
      for (let c = 0; c < count; c++) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        planes.push(plane);
      }
      this.postPlanes(planes);
    } finally {
      data.close();
    }
  }

  private postPlanes(planes: Float32Array[]): void {
    if (!this.node || planes.length === 0) return;
    this.node.port.postMessage(
      planes,
      planes.map((p) => p.buffer),
    );
  }
}

/** S16LE interleaved stereo → float32 planar. Exported for tests. */
export function s16leToPlanar(data: Uint8Array): Float32Array[] {
  const frames = Math.floor(data.length / (2 * CHANNELS));
  const view = new DataView(data.buffer, data.byteOffset, frames * 2 * CHANNELS);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(i * 4, true) / 32768;
    right[i] = view.getInt16(i * 4 + 2, true) / 32768;
  }
  return [left, right];
}

/**
 * WebCodecs wants the FLAC stream header (`fLaC` marker + STREAMINFO block with its 4-byte
 * block header); scrcpy sends only the 34-byte STREAMINFO body. Exported for tests.
 */
export function flacDescription(packet: Uint8Array): Uint8Array {
  if (packet.length !== FLAC_STREAMINFO_LENGTH) return packet;
  const out = new Uint8Array(8 + FLAC_STREAMINFO_LENGTH);
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, FLAC_STREAMINFO_LENGTH], 0);
  out.set(packet, 8);
  return out;
}
