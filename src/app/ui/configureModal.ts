import type { DeviceStreamSettings } from "@common/api.ts";
import type { DeviceDescriptor, ProbeResult } from "@common/protocol.ts";
import type { AudioCodec, AudioSource, VideoCodec } from "@common/scrcpy.ts";
import { api, errorMessage, wsUrl } from "../api.ts";
import { encoderMatchesCodec, isSoftwareEncoder } from "../stream/codec.ts";
import { deviceDisplayName } from "./deviceCard.ts";
import { button, Modal } from "./modal.ts";
import { StreamModal } from "./streamModal.ts";

const VIDEO_CODEC_ORDER: VideoCodec[] = ["h265", "h264", "av1", "vp8", "vp9"];
const AUDIO_CODEC_ORDER: AudioCodec[] = ["opus", "aac", "flac", "raw"];

/** Representative WebCodecs codec strings per scrcpy codec, used only to ask isConfigSupported. */
const DECODER_CODEC_STRING: Record<VideoCodec, string> = {
  h264: "avc1.640028",
  h265: "hvc1.1.6.L120.B0",
  av1: "av01.0.08M.08",
  vp8: "vp8",
  vp9: "vp09.00.40.08",
};

const AUDIO_ENCODER_HINTS: Record<AudioCodec, string[]> = {
  opus: ["opus"],
  aac: ["aac"],
  flac: ["flac"],
  raw: [],
};

const BITRATE_MIN = 512_000;
const BITRATE_MAX = 8_000_000;
const BITRATE_STEP = 512_000;

const DEFAULTS: Required<Omit<DeviceStreamSettings, "videoEncoder" | "displayId">> = {
  videoCodec: "h264",
  audioEnabled: true,
  audioCodec: "opus",
  audioSource: "output",
  bitrate: BITRATE_MAX,
  maxFps: 60,
  maxSize: 0,
  iFrameInterval: 10,
  codecOptions: "",
  fitToScreen: true,
};

function videoCodecOf(encoder: string): VideoCodec | null {
  return VIDEO_CODEC_ORDER.find((codec) => encoderMatchesCodec(encoder, codec)) ?? null;
}

function audioCodecOf(encoder: string): AudioCodec | null {
  const lower = encoder.toLowerCase();
  for (const codec of AUDIO_CODEC_ORDER) {
    if (AUDIO_ENCODER_HINTS[codec].some((h) => lower.includes(h))) return codec;
  }
  return null;
}

async function decodableCodecs(width: number, height: number): Promise<VideoCodec[]> {
  if (typeof VideoDecoder !== "function") return [];
  const out: VideoCodec[] = [];
  for (const codec of VIDEO_CODEC_ORDER) {
    try {
      const res = await VideoDecoder.isConfigSupported({
        codec: DECODER_CODEC_STRING[codec],
        codedWidth: width || 1280,
        codedHeight: height || 720,
      });
      if (res.supported) out.push(codec);
    } catch {
      // unsupported string shape in this browser → treat as not decodable
    }
  }
  return out;
}

function probe(serial: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl("/ws/probe", { serial }));
    let result: ProbeResult | null = null;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          result = JSON.parse(ev.data) as ProbeResult;
        } catch {
          reject(new Error("malformed probe reply"));
        }
      }
    });
    ws.addEventListener("close", (ev) => {
      if (result) resolve(result);
      else reject(new Error(ev.reason || `probe failed (${ev.code})`));
    });
    ws.addEventListener("error", () => {
      // close follows; its reason is more useful
    });
  });
}

function fmtBitrate(bps: number): string {
  return bps >= 1_000_000
    ? `${(bps / 1_000_000).toFixed(1).replace(/\.0$/, "")} Mbps`
    : `${Math.round(bps / 1000)} kbps`;
}

function labeled(label: string, control: HTMLElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

function select<T extends string>(options: { value: T; label: string }[]): HTMLSelectElement {
  const s = document.createElement("select");
  s.className = "select";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  return s;
}

function slider(
  min: number,
  max: number,
  step: number,
  format: (v: number) => string,
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement("div");
  row.className = "field-row";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const out = document.createElement("span");
  out.className = "mono";
  out.style.minWidth = "72px";
  out.style.textAlign = "right";
  const render = () => {
    out.textContent = format(Number(input.value));
  };
  input.addEventListener("input", render);
  row.append(input, out);
  queueMicrotask(render);
  return { row, input };
}

function checkbox(label: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "check";
  const input = document.createElement("input");
  input.type = "checkbox";
  row.append(input, document.createTextNode(label));
  return { row, input };
}

export class ConfigureModal extends Modal {
  private readonly status = document.createElement("div");
  private probeResult: ProbeResult | null = null;
  private decodable: VideoCodec[] = [];
  private saved: DeviceStreamSettings = {};

  private readonly videoCodec = select<VideoCodec>([]);
  private readonly videoEncoder = select<string>([]);
  private readonly maxFps = slider(1, 60, 1, (v) => `${v} fps`);
  private readonly bitrate = slider(BITRATE_MIN, BITRATE_MAX, BITRATE_STEP, fmtBitrate);
  private readonly audioEnabled = checkbox("enable audio");
  private readonly audioCodec = select<AudioCodec>([]);
  private readonly audioSource = select<AudioSource>([]);
  private readonly iFrameInterval = document.createElement("input");
  private readonly fitToScreen = checkbox("fit to screen (max size follows the browser window)");
  private readonly maxSize = document.createElement("input");
  private readonly codecOptions = document.createElement("textarea");
  private readonly form = document.createElement("div");
  private readonly saveBtn: HTMLButtonElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;

  constructor(private readonly device: DeviceDescriptor) {
    super({ title: `Configure stream — ${deviceDisplayName(device)}` });
    this.status.className = "note";
    this.status.textContent = "probing device…";
    this.form.classList.add("hidden");

    this.iFrameInterval.type = "number";
    this.iFrameInterval.className = "input";
    this.iFrameInterval.min = "1";
    this.iFrameInterval.max = "60";
    this.maxSize.type = "number";
    this.maxSize.className = "input";
    this.maxSize.min = "0";
    this.maxSize.step = "8";
    this.maxSize.placeholder = "0 = device resolution";
    this.codecOptions.className = "textarea";
    this.codecOptions.placeholder = "key[:type]=value,…  e.g. profile=8,level=256";

    const advanced = document.createElement("details");
    advanced.className = "configure-advanced";
    const summary = document.createElement("summary");
    summary.textContent = "advanced";
    advanced.append(
      summary,
      labeled("I-frame interval (s)", this.iFrameInterval),
      this.fitToScreen.row,
      labeled("max size (px, longer side)", this.maxSize),
      labeled("codec options", this.codecOptions),
    );
    this.fitToScreen.row.style.marginBottom = "12px";
    this.audioEnabled.row.style.marginBottom = "12px";

    this.form.append(
      labeled("video codec", this.videoCodec),
      labeled("encoder", this.videoEncoder),
      labeled("max fps", this.maxFps.row),
      labeled("bitrate", this.bitrate.row),
      this.audioEnabled.row,
      labeled("audio codec", this.audioCodec),
      labeled("audio source", this.audioSource),
      advanced,
    );
    this.body.append(this.status, this.form);

    this.resetBtn = button("Reset", "default", () => this.applySettings({}));
    this.saveBtn = button("Save", "default", () => void this.save());
    this.connectBtn = button("Save & connect", "primary", () => void this.saveAndConnect());
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    this.footer.append(this.resetBtn, spacer, this.saveBtn, this.connectBtn);
    this.setBusy(true);

    this.videoCodec.addEventListener("change", () => this.renderEncoders(""));
    this.audioEnabled.input.addEventListener("change", () => this.syncAudioControls());
    this.fitToScreen.input.addEventListener("change", () => {
      this.maxSize.disabled = this.fitToScreen.input.checked;
    });
  }

  protected override onOpen(): void {
    void this.load();
  }

  private setBusy(busy: boolean): void {
    this.saveBtn.disabled = busy;
    this.connectBtn.disabled = busy;
    this.resetBtn.disabled = busy;
  }

  private async load(): Promise<void> {
    try {
      const [probeResult, saved] = await Promise.all([
        probe(this.device.serial),
        api.settings.device(this.device.serial),
      ]);
      if (this.closeStarted) return;
      this.probeResult = probeResult;
      this.saved = saved;
      this.decodable = await decodableCodecs(probeResult.width, probeResult.height);
      if (this.closeStarted) return;
      this.buildOptions();
      this.applySettings(saved);
      this.status.textContent = `ready — ${probeResult.width}×${probeResult.height}, SDK ${probeResult.sdk}, ${probeResult.videoEncoders.length} video / ${probeResult.audioEncoders.length} audio encoders`;
      this.form.classList.remove("hidden");
      this.setBusy(false);
    } catch (err) {
      this.status.className = "note note-error";
      this.status.textContent = `probe failed: ${errorMessage(err)}`;
    }
  }

  private get sdk(): number {
    return this.probeResult?.sdk ?? this.device.sdk ?? 0;
  }

  private buildOptions(): void {
    const encoders = this.probeResult?.videoEncoders ?? [];
    const deviceCodecs = new Set<VideoCodec>();
    for (const e of encoders) {
      const c = videoCodecOf(e);
      if (c) deviceCodecs.add(c);
    }
    let codecs = VIDEO_CODEC_ORDER.filter((c) => deviceCodecs.has(c) && this.decodable.includes(c));
    if (codecs.length === 0) codecs = this.decodable.length ? this.decodable : ["h264"];
    this.videoCodec.replaceChildren();
    for (const c of codecs) this.videoCodec.add(new Option(c, c));

    const audioEncoders = this.probeResult?.audioEncoders ?? [];
    const audioCodecs = AUDIO_CODEC_ORDER.filter(
      (c) => c === "raw" || audioEncoders.some((e) => audioCodecOf(e) === c),
    );
    this.audioCodec.replaceChildren();
    for (const c of audioCodecs) this.audioCodec.add(new Option(c, c));

    this.audioSource.replaceChildren();
    this.audioSource.add(new Option("output (device audio)", "output"));
    if (this.sdk >= 33) this.audioSource.add(new Option("playback (apps only, Android 13+)", "playback"));
    this.audioSource.add(new Option("microphone", "mic"));
  }

  /** Fills the encoder dropdown for the selected codec; blank = auto; prefers hardware. */
  private renderEncoders(selected: string): void {
    const codec = this.videoCodec.value as VideoCodec;
    const matching = (this.probeResult?.videoEncoders ?? []).filter((e) => videoCodecOf(e) === codec);
    this.videoEncoder.replaceChildren();
    this.videoEncoder.add(new Option("auto", ""));
    for (const e of matching) this.videoEncoder.add(new Option(`${e}${isSoftwareEncoder(e) ? " (software)" : ""}`, e));
    if (selected && matching.includes(selected)) {
      this.videoEncoder.value = selected;
    } else if (!selected && codec === "h265") {
      // Hardware HEVC is the best default when the device offers it.
      const hw = matching.find((e) => !isSoftwareEncoder(e));
      this.videoEncoder.value = hw ?? "";
    } else {
      this.videoEncoder.value = "";
    }
  }

  private syncAudioControls(): void {
    const audioSupported = this.sdk >= 30;
    this.audioEnabled.input.disabled = !audioSupported;
    this.audioEnabled.row.title = audioSupported ? "" : "audio capture needs Android 11 (SDK 30) or newer";
    const on = audioSupported && this.audioEnabled.input.checked;
    this.audioCodec.disabled = !on;
    this.audioSource.disabled = !on;
  }

  private applySettings(s: DeviceStreamSettings): void {
    const codecs = [...this.videoCodec.options].map((o) => o.value as VideoCodec);
    const defaultCodec = codecs.includes("h265") ? "h265" : (codecs[0] ?? DEFAULTS.videoCodec);
    this.videoCodec.value = s.videoCodec && codecs.includes(s.videoCodec) ? s.videoCodec : defaultCodec;
    this.renderEncoders(s.videoEncoder ?? "");
    this.maxFps.input.value = String(s.maxFps ?? DEFAULTS.maxFps);
    this.bitrate.input.value = String(Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, s.bitrate ?? DEFAULTS.bitrate)));
    this.maxFps.input.dispatchEvent(new Event("input"));
    this.bitrate.input.dispatchEvent(new Event("input"));
    this.audioEnabled.input.checked = this.sdk >= 30 && (s.audioEnabled ?? DEFAULTS.audioEnabled);
    const audioCodecs = [...this.audioCodec.options].map((o) => o.value as AudioCodec);
    this.audioCodec.value =
      s.audioCodec && audioCodecs.includes(s.audioCodec) ? s.audioCodec : (audioCodecs[0] ?? DEFAULTS.audioCodec);
    const sources = [...this.audioSource.options].map((o) => o.value as AudioSource);
    this.audioSource.value = s.audioSource && sources.includes(s.audioSource) ? s.audioSource : DEFAULTS.audioSource;
    this.iFrameInterval.value = String(s.iFrameInterval ?? DEFAULTS.iFrameInterval);
    this.fitToScreen.input.checked = s.fitToScreen ?? DEFAULTS.fitToScreen;
    this.maxSize.value = String(s.maxSize ?? DEFAULTS.maxSize);
    this.maxSize.disabled = this.fitToScreen.input.checked;
    this.codecOptions.value = s.codecOptions ?? DEFAULTS.codecOptions;
    this.syncAudioControls();
  }

  private collect(): DeviceStreamSettings {
    return {
      videoCodec: this.videoCodec.value as VideoCodec,
      videoEncoder: this.videoEncoder.value,
      maxFps: Number(this.maxFps.input.value),
      bitrate: Number(this.bitrate.input.value),
      audioEnabled: this.audioEnabled.input.checked,
      audioCodec: this.audioCodec.value as AudioCodec,
      audioSource: this.audioSource.value as AudioSource,
      iFrameInterval: Math.max(1, Math.round(Number(this.iFrameInterval.value) || DEFAULTS.iFrameInterval)),
      fitToScreen: this.fitToScreen.input.checked,
      maxSize: Math.max(0, Math.round(Number(this.maxSize.value) || 0)),
      codecOptions: this.codecOptions.value.trim(),
    };
  }

  private async save(): Promise<DeviceStreamSettings | null> {
    this.setBusy(true);
    const settings = this.collect();
    try {
      this.saved = await api.settings.patchDevice(this.device.serial, settings);
      this.status.className = "note";
      this.status.textContent = "saved";
      return this.saved;
    } catch (err) {
      this.status.className = "note note-error";
      this.status.textContent = `save failed: ${errorMessage(err)}`;
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  private async saveAndConnect(): Promise<void> {
    const settings = await this.save();
    if (!settings || this.closeStarted) return;
    this.close();
    new StreamModal(this.device, { ...this.saved, ...settings }).open();
  }
}
