/**
 * VideoDecoder → canvas 2D renderer. Keeps only the newest decoded frame, gates decoding on a
 * keyframe after every (re)configure, and runs a 5 s decode watchdog that asks the device for a
 * fresh keyframe (RESET_VIDEO) at most `MAX_RESET_REQUESTS` times per session.
 */
import type { VideoCodec } from "@common/scrcpy.ts";
import { annexBToLengthPrefixed, buildConfigFromPacket, buildConfiglessConfig, isConfiglessCodec } from "./codec.ts";
import type { MediaPacket } from "./demuxer.ts";

export interface ScreenInfo {
  width: number;
  height: number;
}

export interface VideoSecondStats {
  inputFps: number;
  decodedFps: number;
  droppedFps: number;
  bytesPerSecond: number;
}

export interface VideoRendererOptions {
  canvas: HTMLCanvasElement;
  /** fit target; the renderer sizes `stack` to fit this box while keeping the aspect ratio */
  container: HTMLElement;
  stack: HTMLElement;
  /** send RESET_VIDEO; the renderer limits calls per session */
  requestReset(): void;
}

const WATCHDOG_MS = 5000;
const MAX_RESET_REQUESTS = 3;
/** consecutive decoder errors without a decoded frame before we stop rebuilding the decoder */
const MAX_CONSECUTIVE_FAILURES = 5;
/** codecs whose `description` (avcC/hvcC) requires length-prefixed NAL units */
const LENGTH_PREFIXED_CODECS: Record<string, true> = { h264: true, h265: true };

export class VideoRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly container: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly requestReset: () => void;
  private readonly resizeObserver: ResizeObserver;

  private decoder: VideoDecoder | null = null;
  private codec: VideoCodec | null = null;
  private lastConfig: VideoDecoderConfig | null = null;
  private seenKeyframe = false;
  private watchdog: number | undefined;
  private resetRequests = 0;
  private resetExhaustedLogged = false;
  private consecutiveFailures = 0;
  private pendingFrame: VideoFrame | null = null;
  private rafId = 0;
  private stopped = false;

  /** current video size per the latest session packet; touch/scroll must use this */
  readonly screenInfo: ScreenInfo = { width: 0, height: 0 };

  private inputFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private bytes = 0;
  /** true once any frame has been painted */
  hasPicture = false;

  constructor(opts: VideoRendererOptions) {
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx = ctx;
    this.container = opts.container;
    this.stack = opts.stack;
    this.requestReset = opts.requestReset;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.container);
  }

  /** Codec from METADATA. Configless codecs are configured right away. */
  setCodec(codec: VideoCodec, width: number, height: number): void {
    this.codec = codec;
    this.resetRequests = 0;
    this.resetExhaustedLogged = false;
    this.consecutiveFailures = 0;
    this.onSourceResize(width, height);
    this.createDecoder();
    if (isConfiglessCodec(codec)) this.configure(buildConfiglessConfig(codec, width, height));
  }

  /** SESSION packet: new capture size. Resizes the canvas immediately and updates screenInfo. */
  onSourceResize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.screenInfo.width = width;
    this.screenInfo.height = height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.fit();
    if (this.codec && isConfiglessCodec(this.codec) && this.decoder) {
      this.configure(buildConfiglessConfig(this.codec, width, height));
    }
  }

  push(packet: MediaPacket): void {
    if (this.stopped || !this.codec) return;
    this.bytes += packet.data.length;
    if (packet.isConfig) {
      if (isConfiglessCodec(this.codec)) return;
      const built = buildConfigFromPacket(this.codec, packet.data, this.screenInfo.width, this.screenInfo.height);
      if (built) {
        if (built.displayWidth && built.displayHeight) this.onSourceResize(built.displayWidth, built.displayHeight);
        this.consecutiveFailures = 0;
        this.configure(built.config);
      }
      return;
    }
    this.inputFrames++;
    if (this.decoder?.state !== "configured") return;
    if (!this.seenKeyframe) {
      if (!packet.isKeyframe) {
        this.droppedFrames++;
        return;
      }
      this.seenKeyframe = true;
    }
    const data = LENGTH_PREFIXED_CODECS[this.codec] ? annexBToLengthPrefixed(packet.data) : packet.data;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: packet.isKeyframe ? "key" : "delta",
          timestamp: Number(packet.pts),
          data,
        }),
      );
    } catch (err) {
      console.warn("[video] decode threw", err);
      this.recoverDecoder();
    }
  }

  /** Rates for the last second; resets the counters. */
  takeSecond(): VideoSecondStats {
    const out = {
      inputFps: this.inputFrames,
      decodedFps: this.decodedFrames,
      droppedFps: this.droppedFrames,
      bytesPerSecond: this.bytes,
    };
    this.inputFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.bytes = 0;
    return out;
  }

  screenshot(name: string): void {
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
    this.resizeObserver.disconnect();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.pendingFrame?.close();
    this.pendingFrame = null;
    this.closeDecoder();
  }

  // ---------------------------------------------------------------- internals

  private createDecoder(): void {
    this.closeDecoder();
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.warn("[video] decoder error", err);
        this.recoverDecoder();
      },
    });
    this.seenKeyframe = false;
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  private configure(config: VideoDecoderConfig): void {
    if (!this.decoder || this.decoder.state === "closed") this.createDecoder();
    const decoder = this.decoder;
    if (!decoder) return;
    try {
      decoder.configure(config);
    } catch (err) {
      console.warn("[video] configure failed", err);
      this.createDecoder();
      return;
    }
    this.lastConfig = config;
    this.seenKeyframe = false;
    this.armWatchdog();
  }

  /**
   * Recreate the decoder in place; re-configure when we have what we need, else wait for config.
   * After `MAX_CONSECUTIVE_FAILURES` errors without a decoded frame the decoder stays closed until
   * the next config packet or Refresh, so a config the platform rejects cannot loop forever.
   */
  recoverDecoder(): void {
    if (this.stopped) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      if (this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES + 1) {
        console.warn("[video] decoder keeps failing; waiting for a new config or Refresh");
      }
      this.closeDecoder();
      this.clearWatchdog();
      return;
    }
    this.createDecoder();
    if (this.codec && isConfiglessCodec(this.codec)) {
      this.configure(buildConfiglessConfig(this.codec, this.screenInfo.width, this.screenInfo.height));
    } else if (this.lastConfig) {
      this.configure(this.lastConfig);
    }
    this.askForReset();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = window.setTimeout(() => {
      this.watchdog = undefined;
      if (this.stopped) return;
      console.warn("[video] no decoded frame within 5 s");
      if (this.askForReset()) this.armWatchdog();
    }, WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private askForReset(): boolean {
    if (this.resetRequests >= MAX_RESET_REQUESTS) {
      if (!this.resetExhaustedLogged) {
        this.resetExhaustedLogged = true;
        console.warn("[video] RESET_VIDEO budget exhausted; use Refresh");
      }
      return false;
    }
    this.resetRequests++;
    this.requestReset();
    return true;
  }

  private onFrame(frame: VideoFrame): void {
    this.clearWatchdog();
    this.consecutiveFailures = 0;
    this.decodedFrames++;
    if (this.stopped) {
      frame.close();
      return;
    }
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.droppedFrames++;
    }
    this.pendingFrame = frame;
    if (!this.rafId) this.rafId = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    this.rafId = 0;
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (!frame) return;
    const rect = frame.visibleRect;
    const sx = rect ? rect.x : 0;
    const sy = rect ? rect.y : 0;
    const sw = rect ? rect.width : frame.codedWidth;
    const sh = rect ? rect.height : frame.codedHeight;
    const dw = frame.displayWidth || sw;
    const dh = frame.displayHeight || sh;
    if (this.canvas.width !== dw || this.canvas.height !== dh) {
      this.canvas.width = dw;
      this.canvas.height = dh;
      this.fit();
    }
    this.ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, dw, dh);
    frame.close();
    this.hasPicture = true;
  }

  /** Size the canvas stack to fit the container, preserving the video aspect ratio. */
  private fit(): void {
    const vw = this.canvas.width;
    const vh = this.canvas.height;
    if (vw === 0 || vh === 0) return;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    if (cw === 0 || ch === 0) return;
    const scale = Math.min(cw / vw, ch / vh);
    const w = Math.floor(vw * scale);
    const h = Math.floor(vh * scale);
    this.stack.style.width = `${w}px`;
    this.stack.style.height = `${h}px`;
  }
}
