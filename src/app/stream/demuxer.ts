/**
 * /ws/stream client: strips the channel byte and dispatches VIDEO/AUDIO media packets,
 * METADATA/SESSION JSON and reassembled device messages. Pure helpers are exported for tests.
 */
import { ChannelId, type SessionChange, type StreamMetadata, type StreamQuery } from "@common/protocol.ts";
import { DeviceMsg, FRAME_HEADER_SIZE, PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME, PTS_MASK } from "@common/scrcpy.ts";

export interface MediaPacket {
  /** microseconds */
  pts: bigint;
  isConfig: boolean;
  isKeyframe: boolean;
  data: Uint8Array;
}

/** Parse `[8B ptsAndFlags][4B size][data]`; returns null when the frame is truncated. */
export function parseMediaPacket(frame: Uint8Array): MediaPacket | null {
  if (frame.length < FRAME_HEADER_SIZE) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const ptsAndFlags = view.getBigUint64(0);
  const size = view.getUint32(8);
  if (frame.length < FRAME_HEADER_SIZE + size) return null;
  return {
    pts: ptsAndFlags & PTS_MASK,
    isConfig: (ptsAndFlags & PTS_FLAG_CONFIG) !== 0n,
    isKeyframe: (ptsAndFlags & PTS_FLAG_KEYFRAME) !== 0n,
    data: frame.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + size),
  };
}

export type DeviceMessage =
  | { type: "clipboard"; text: string }
  | { type: "ack-clipboard"; sequence: bigint }
  | { type: "uhid-output"; id: number; data: Uint8Array };

const textDecoder = new TextDecoder();

/** Reassembles device messages (§6) from an arbitrary chunking of the control socket bytes. */
export class DeviceMessageReassembler {
  private buffer: Uint8Array = new Uint8Array(0);
  /** Set once an unknown type byte is seen; nothing further is parsed. */
  desynced = false;

  push(chunk: Uint8Array): DeviceMessage[] {
    const out: DeviceMessage[] = [];
    if (this.desynced) return out;
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    for (;;) {
      const parsed = parseOneDeviceMessage(this.buffer);
      if (parsed === "desync") {
        this.desynced = true;
        this.buffer = new Uint8Array(0);
        return out;
      }
      if (parsed === null) return out;
      out.push(parsed.message);
      this.buffer = this.buffer.subarray(parsed.consumed);
    }
  }
}

function parseOneDeviceMessage(buf: Uint8Array): { message: DeviceMessage; consumed: number } | null | "desync" {
  if (buf.length < 1) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (buf[0]) {
    case DeviceMsg.CLIPBOARD: {
      if (buf.length < 5) return null;
      const len = view.getUint32(1);
      if (buf.length < 5 + len) return null;
      return { message: { type: "clipboard", text: textDecoder.decode(buf.subarray(5, 5 + len)) }, consumed: 5 + len };
    }
    case DeviceMsg.ACK_CLIPBOARD: {
      if (buf.length < 9) return null;
      return { message: { type: "ack-clipboard", sequence: view.getBigUint64(1) }, consumed: 9 };
    }
    case DeviceMsg.UHID_OUTPUT: {
      if (buf.length < 5) return null;
      const id = view.getUint16(1);
      const size = view.getUint16(3);
      if (buf.length < 5 + size) return null;
      return { message: { type: "uhid-output", id, data: buf.slice(5, 5 + size) }, consumed: 5 + size };
    }
    default:
      return "desync";
  }
}

export type StreamEnd = { kind: "normal"; reason?: string } | { kind: "error"; error: Error };

export function classifyClose(code: number, reason: string): StreamEnd {
  if (code === 1000 || code === 1001 || code === 1005) return reason ? { kind: "normal", reason } : { kind: "normal" };
  return { kind: "error", error: new Error(reason || `WebSocket closed with code ${code}`) };
}

export function buildStreamUrl(query: StreamQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws/stream?${params.toString()}`;
}

export interface DemuxerHandlers {
  onMetadata(meta: StreamMetadata): void;
  onSession(change: SessionChange): void;
  onVideo(packet: MediaPacket): void;
  onAudio(packet: MediaPacket): void;
  onDeviceMessage(message: DeviceMessage): void;
  onEnd(end: StreamEnd): void;
}

export class Demuxer {
  private readonly ws: WebSocket;
  private readonly reassembler = new DeviceMessageReassembler();
  private readonly pending: Uint8Array[] = [];
  private ended = false;
  private desyncLogged = false;

  constructor(
    readonly url: string,
    private readonly handlers: DemuxerHandlers,
  ) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      for (const bytes of this.pending) this.ws.send(bytes);
      this.pending.length = 0;
    };
    this.ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);
    this.ws.onclose = (ev: CloseEvent) => this.finish(classifyClose(ev.code, ev.reason));
    this.ws.onerror = () => {
      // onclose follows with the real code; nothing to do here.
    };
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Prepend the CONTROL channel byte and send; queued while CONNECTING, dropped after close. */
  sendControl(bytes: Uint8Array): void {
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = ChannelId.CONTROL;
    frame.set(bytes, 1);
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pending.push(frame);
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  /** Close locally. `onEnd` fires as normal with `reason`. */
  close(reason?: string): void {
    if (this.ended) return;
    this.ws.onclose = null;
    this.ws.onmessage = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, reason);
    }
    this.finish(reason ? { kind: "normal", reason } : { kind: "normal" });
  }

  /** Detach the end callback (refresh path: the old socket's close must not end the stream). */
  detach(): void {
    this.ended = true;
    this.ws.onclose = null;
    this.ws.onmessage = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "refresh");
    }
  }

  private finish(end: StreamEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onEnd(end);
  }

  private onMessage(ev: MessageEvent): void {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const frame = new Uint8Array(ev.data);
    if (frame.length === 0) return;
    const payload = frame.subarray(1);
    switch (frame[0]) {
      case ChannelId.VIDEO: {
        const packet = parseMediaPacket(payload);
        if (packet) this.handlers.onVideo(packet);
        return;
      }
      case ChannelId.AUDIO: {
        const packet = parseMediaPacket(payload);
        if (packet) this.handlers.onAudio(packet);
        return;
      }
      case ChannelId.METADATA:
        this.handlers.onMetadata(JSON.parse(textDecoder.decode(payload)) as StreamMetadata);
        return;
      case ChannelId.SESSION:
        this.handlers.onSession(JSON.parse(textDecoder.decode(payload)) as SessionChange);
        return;
      case ChannelId.DEVICE_MSG: {
        for (const message of this.reassembler.push(payload)) this.handlers.onDeviceMessage(message);
        if (this.reassembler.desynced && !this.desyncLogged) {
          this.desyncLogged = true;
          console.warn("[stream] unknown device message type; device messages ignored for this session");
        }
        return;
      }
      default:
        return;
    }
  }
}
