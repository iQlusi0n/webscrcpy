/**
 * `startStream(opts)`: mounts toolbar + canvas layers into `opts.container`, picks a video codec,
 * opens /ws/stream and wires decoding, audio, input and clipboard. See types.ts for the contract.
 */
import "./stream.css";
import type { DeviceStreamSettings, ScreenStateResponse } from "@common/api.ts";
import type { ProbeResult, StreamMetadata } from "@common/protocol.ts";
import { KeyAction, type VideoCodec } from "@common/scrcpy.ts";
import { isSerial, VIDEO_CODECS } from "@common/validate.ts";
import { AudioPlayer } from "./audio.ts";
import { FALLBACK_CODEC, probeDecodeSupport, selectCodec } from "./codec.ts";
import { expandNotificationPanel, injectKeycode, resetVideo, rotateDevice } from "./control.ts";
import { buildStreamUrl, Demuxer, type StreamEnd } from "./demuxer.ts";
import { ClipboardSync } from "./input/clipboard.ts";
import { DpadInput } from "./input/dpad.ts";
import { KeyboardInput } from "./input/keyboard.ts";
import { TouchInput } from "./input/touch.ts";
import { UhidInput } from "./input/uhid.ts";
import { buildStreamQuery, looksLikeNoPicture } from "./query.ts";
import { StatsOverlay } from "./stats.ts";
import { type ToggleName, Toolbar } from "./toolbar.ts";
import type { StartStream, StreamHandle, StreamOptions, StreamStats } from "./types.ts";
import { VideoRenderer } from "./video.ts";

export type { StartStream, StreamHandle, StreamOptions, StreamStats } from "./types.ts";

const PROBE_TIMEOUT_MS = 8000;
const NO_PICTURE_WINDOW = 30;
const NO_PICTURE_CHECKS = 5;
const LOCK_CHECK_INTERVAL_MS = 5000;

function fetchProbe(serial: string): Promise<ProbeResult | undefined> {
  const { promise, resolve } = Promise.withResolvers<ProbeResult | undefined>();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${scheme}//${location.host}/ws/probe?serial=${encodeURIComponent(serial)}`);
  } catch {
    resolve(undefined);
    return promise;
  }
  let done = false;
  const finish = (result: ProbeResult | undefined): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(result);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
  const timer = window.setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    try {
      finish(JSON.parse(ev.data) as ProbeResult);
    } catch {
      finish(undefined);
    }
  };
  ws.onerror = () => finish(undefined);
  ws.onclose = () => finish(undefined);
  return promise;
}

async function chooseCodec(
  serial: string,
  settings: DeviceStreamSettings,
): Promise<{ codec: VideoCodec | undefined; encoder: string | undefined }> {
  if (settings.videoCodec) {
    const supported = await probeDecodeSupport(settings.videoCodec);
    if (supported === false) {
      console.warn(`[stream] browser cannot decode ${settings.videoCodec}; falling back to ${FALLBACK_CODEC}`);
      return { codec: FALLBACK_CODEC, encoder: undefined };
    }
    return { codec: settings.videoCodec, encoder: settings.videoEncoder };
  }
  const [probe, ...answers] = await Promise.all([
    fetchProbe(serial),
    ...VIDEO_CODECS.map((codec) => probeDecodeSupport(codec)),
  ]);
  const support = {} as Record<VideoCodec, boolean | undefined>;
  VIDEO_CODECS.forEach((codec, i) => {
    support[codec] = answers[i];
  });
  const choice = selectCodec(support, probe?.videoEncoders);
  return { codec: choice.codec, encoder: settings.videoEncoder ?? choice.encoder };
}

class StreamSession implements StreamHandle {
  readonly serial: string;
  metadata: StreamMetadata | null = null;

  private readonly opts: StreamOptions;
  private readonly root: HTMLElement;
  private readonly videoArea: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly statsCanvas: HTMLCanvasElement;
  private readonly lockedBanner: HTMLElement;
  private readonly toolbar: Toolbar;
  private readonly video: VideoRenderer;
  private readonly statsOverlay: StatsOverlay;
  private readonly touch: TouchInput;
  private readonly dpad: DpadInput;
  private readonly keyboard: KeyboardInput;
  private readonly uhid: UhidInput;
  private readonly clipboard: ClipboardSync;

  private demuxer: Demuxer | null = null;
  private url: string | null = null;
  private audio: AudioPlayer | null = null;
  private ended = false;
  private stopped = false;
  private tick: number | undefined;
  private stats: StreamStats = {
    resolution: "",
    codec: "",
    inputFps: 0,
    decodedFps: 0,
    droppedFps: 0,
    bytesPerSecond: 0,
  };

  private readonly frameSizes: number[] = [];
  private baselineBytes = 0;
  private noPictureChecks = 0;
  private lastLockCheck = 0;

  constructor(opts: StreamOptions) {
    this.opts = opts;
    this.serial = opts.serial;

    this.root = document.createElement("div");
    this.root.className = "stream-root";
    this.videoArea = document.createElement("div");
    this.videoArea.className = "stream-video";
    this.videoArea.tabIndex = 0;
    this.stack = document.createElement("div");
    this.stack.className = "stream-canvas-stack";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "stream-canvas";
    this.overlay = document.createElement("canvas");
    this.overlay.className = "stream-overlay";
    this.statsCanvas = document.createElement("canvas");
    this.statsCanvas.className = "stream-stats";
    this.statsCanvas.hidden = true;
    this.stack.append(this.canvas, this.overlay, this.statsCanvas);
    this.lockedBanner = document.createElement("div");
    this.lockedBanner.className = "stream-locked-banner";
    this.lockedBanner.textContent = "Device is locked — unlock it to see the screen";
    this.lockedBanner.hidden = true;
    this.videoArea.append(this.stack, this.lockedBanner);

    const dpadDefault = opts.dpadMode ?? opts.deviceKind === "tv";
    this.toolbar = new Toolbar(
      { keyboard: true, uhid: false, stats: false, dpad: dpadDefault },
      {
        key: (keycode, down) => this.send(injectKeycode(down ? KeyAction.DOWN : KeyAction.UP, keycode, 0, 0)),
        screenshot: () => this.screenshot(),
        refresh: () => this.refresh(),
        clipboardGet: () => this.clipboard.requestFromDevice(),
        clipboardSet: () => void this.clipboard.pushToDevice(),
        rotate: () => this.send(rotateDevice()),
        expandNotifications: () => this.send(expandNotificationPanel()),
        toggle: (name, enabled) => this.onToggle(name, enabled),
      },
    );
    this.root.append(this.toolbar.element, this.videoArea);
    opts.container.appendChild(this.root);

    this.video = new VideoRenderer({
      canvas: this.canvas,
      container: this.videoArea,
      stack: this.stack,
      requestReset: () => this.send(resetVideo()),
    });
    this.statsOverlay = new StatsOverlay(this.statsCanvas);
    const send = (bytes: Uint8Array): void => this.send(bytes);
    this.touch = new TouchInput({ send, canvas: this.canvas, overlay: this.overlay, screen: this.video.screenInfo });
    this.dpad = new DpadInput(send, this.canvas);
    this.keyboard = new KeyboardInput({ send, container: this.root, canvas: this.canvas });
    this.uhid = new UhidInput(send, this.canvas);
    this.clipboard = new ClipboardSync(send, this.videoArea);
    this.canvas.addEventListener("pointerdown", () => this.videoArea.focus({ preventScroll: true }));
    this.applyInputMode();

    void this.open();
  }

  get isConnected(): boolean {
    return this.demuxer?.isOpen === true && this.metadata !== null;
  }

  // ---------------------------------------------------------------- StreamHandle

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.demuxer?.close();
    this.teardownMedia();
    this.touch.destroy();
    this.dpad.destroy();
    this.keyboard.destroy();
    this.uhid.destroy();
    this.clipboard.destroy();
    this.video.stop();
    this.root.remove();
    this.end({ kind: "normal" });
  }

  refresh(): void {
    if (this.stopped || !this.url) return;
    const old = this.demuxer;
    this.demuxer = null;
    old?.detach();
    this.teardownMedia();
    this.metadata = null;
    this.frameSizes.length = 0;
    this.baselineBytes = 0;
    this.noPictureChecks = 0;
    this.touch.releaseAll();
    this.connect(this.url);
  }

  setDpadMode(enabled: boolean): void {
    this.toolbar.setToggle("dpad", enabled);
    this.applyInputMode();
  }

  setCaptureKeyboard(enabled: boolean): void {
    this.toolbar.setToggle("keyboard", enabled);
    this.applyInputMode();
  }

  setUhid(enabled: boolean): void {
    this.toolbar.setToggle("uhid", enabled);
    this.applyInputMode();
  }

  setShowStats(enabled: boolean): void {
    this.toolbar.setToggle("stats", enabled);
    this.statsOverlay.setVisible(enabled);
  }

  screenshot(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.video.screenshot(`${this.serial}-${stamp}.png`);
  }

  getStats(): StreamStats {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------- lifecycle

  private async open(): Promise<void> {
    if (!isSerial(this.serial)) {
      this.end({ kind: "error", error: new Error("invalid serial") });
      return;
    }
    let codec: VideoCodec | undefined;
    let encoder: string | undefined;
    try {
      ({ codec, encoder } = await chooseCodec(this.serial, this.opts.settings));
    } catch (err) {
      this.end({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    if (this.stopped) return;
    this.url = buildStreamUrl(buildStreamQuery(this.serial, this.opts.settings, codec, encoder));
    this.connect(this.url);
  }

  private connect(url: string): void {
    let demuxer: Demuxer;
    try {
      demuxer = new Demuxer(url, {
        onMetadata: (meta) => this.onMetadata(meta),
        onSession: (s) => this.video.onSourceResize(s.width, s.height),
        onVideo: (packet) => {
          if (!packet.isConfig) this.recordFrameSize(packet.data.length);
          this.video.push(packet);
        },
        onAudio: (packet) => this.audio?.push(packet),
        onDeviceMessage: (message) => {
          if (message.type === "clipboard") this.clipboard.onDeviceClipboard(message.text);
          else if (message.type === "ack-clipboard") this.clipboard.onAck(message.sequence);
        },
        onEnd: (end) => {
          if (this.demuxer !== demuxer) return;
          this.demuxer = null;
          this.teardownMedia();
          this.end(end);
        },
      });
    } catch (err) {
      this.end({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    this.demuxer = demuxer;
  }

  private onMetadata(meta: StreamMetadata): void {
    this.metadata = meta;
    this.video.setCodec(meta.videoCodec, meta.width, meta.height);
    this.stats.codec = meta.videoCodec;
    if (meta.videoEncoder) this.stats.encoder = meta.videoEncoder;
    else delete this.stats.encoder;
    this.stats.resolution = `${meta.width}×${meta.height}`;
    const audioWanted = this.opts.settings.audioEnabled !== false;
    if (audioWanted && meta.audioCodec !== "disabled" && meta.audioCodec !== "error") {
      const player = new AudioPlayer();
      this.audio = player;
      player.start(meta.audioCodec).catch((err) => {
        console.warn("[audio] start failed", err);
        if (this.audio === player) {
          player.stop();
          this.audio = null;
        }
      });
    }
    clearInterval(this.tick);
    this.tick = window.setInterval(() => this.onTick(), 1000);
    this.opts.onConnect?.(meta);
  }

  private teardownMedia(): void {
    clearInterval(this.tick);
    this.tick = undefined;
    this.audio?.stop();
    this.audio = null;
  }

  /** Exactly one of onDisconnect/onError, once. */
  private end(end: StreamEnd): void {
    if (this.ended) return;
    this.ended = true;
    if (end.kind === "normal") this.opts.onDisconnect?.(end.reason);
    else this.opts.onError?.(end.error);
  }

  private send(bytes: Uint8Array): void {
    this.demuxer?.sendControl(bytes);
  }

  // ---------------------------------------------------------------- input modes

  private onToggle(name: ToggleName, enabled: boolean): void {
    if (name === "stats") this.statsOverlay.setVisible(enabled);
    else this.applyInputMode();
  }

  private applyInputMode(): void {
    const uhid = this.toolbar.isToggled("uhid");
    const dpad = this.toolbar.isToggled("dpad");
    const keyboard = this.toolbar.isToggled("keyboard");
    if (uhid) {
      this.touch.setEnabled(false);
      this.dpad.setEnabled(false);
      this.keyboard.setEnabled(false);
      this.uhid.setEnabled(true);
      return;
    }
    this.uhid.setEnabled(false);
    this.touch.setEnabled(!dpad);
    this.dpad.setEnabled(dpad);
    this.keyboard.setEnabled(keyboard);
  }

  // ---------------------------------------------------------------- 1 Hz housekeeping

  private onTick(): void {
    const second = this.video.takeSecond();
    const { width, height } = this.video.screenInfo;
    this.stats = {
      ...this.stats,
      resolution: `${width}×${height}`,
      inputFps: second.inputFps,
      decodedFps: second.decodedFps,
      droppedFps: second.droppedFps,
      bytesPerSecond: second.bytesPerSecond,
    };
    this.statsOverlay.render(this.stats);
    this.checkNoPicture();
  }

  private recordFrameSize(bytes: number): void {
    this.frameSizes.push(bytes);
    if (this.frameSizes.length > NO_PICTURE_WINDOW) this.frameSizes.shift();
  }

  private checkNoPicture(): void {
    if (this.frameSizes.length < 10) return;
    let sum = 0;
    for (const n of this.frameSizes) sum += n;
    const avg = sum / this.frameSizes.length;
    if (avg > this.baselineBytes) this.baselineBytes = avg;
    if (looksLikeNoPicture(avg, this.baselineBytes)) {
      this.noPictureChecks++;
      if (this.noPictureChecks >= NO_PICTURE_CHECKS) {
        this.noPictureChecks = 0;
        void this.refreshLockedBanner();
      }
    } else {
      this.noPictureChecks = 0;
      this.lockedBanner.hidden = true;
    }
  }

  private async refreshLockedBanner(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLockCheck < LOCK_CHECK_INTERVAL_MS) return;
    this.lastLockCheck = now;
    try {
      const res = await fetch(`/api/devices/screen-state?serial=${encodeURIComponent(this.serial)}`);
      if (!res.ok) return;
      const state = (await res.json()) as ScreenStateResponse;
      this.lockedBanner.hidden = state.locked !== true;
    } catch {
      // offline or restarting: say nothing
    }
  }
}

export const startStream: StartStream = (opts) => new StreamSession(opts);
