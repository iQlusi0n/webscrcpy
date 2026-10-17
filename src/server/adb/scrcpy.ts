/**
 * `/ws/stream?serial=…` — one scrcpy-server session per socket: push jar, tunnel, launch,
 * demux video/audio/control into channel-prefixed WebSocket frames (SCRCPY_PROTOCOL.md).
 */

import { ChannelId, type SessionChange, type StreamMetadata, WsClose } from "@common/protocol.ts";
import {
  AUDIO_CODEC_IDS,
  AUDIO_DISABLED,
  AUDIO_ERROR,
  ControlMsg,
  DEVICE_NAME_FIELD_LENGTH,
  VIDEO_CODEC_IDS,
} from "@common/scrcpy.ts";
import type { Adb, AdbNoneProtocolProcess, AdbSocket } from "@yume-chan/adb";
import type { WritableStreamDefaultWriter } from "@yume-chan/stream-extra";
import {
  type AppRouter,
  type AppServices,
  type AppSocket,
  HttpError,
  type Logger,
  type RequestContext,
} from "../app.ts";
import { CongestionController } from "./congestion.ts";
import {
  buildJsonFrame,
  buildMediaFrame,
  decodeDeviceName,
  parseFrameHeader,
  readU32,
  SocketReader,
} from "./frames.ts";
import { ensureServerJar } from "./jar.ts";
import {
  buildServerCommand,
  chooseAudioCodec,
  type LaunchOptions,
  parseStreamQuery,
  randomScid,
  type StreamOptions,
  serializeServerOptions,
} from "./options.ts";
import { audioEncodersFor } from "./probe.ts";
import { type AdbService, describe } from "./service.ts";
import { ReverseTunnel } from "./tunnel.ts";
import { closeWith, LiveSockets } from "./ws.ts";

const ACCEPT_TIMEOUT_MS = 10_000;
const FORWARD_CONNECT_DEADLINE_MS = 120_000;
const FORWARD_RETRY_MS = 150;
const STALL_TIMEOUT_MS = 8_000;
const STALL_RETRY_MS = 2_000;
const STALL_MAX_RESETS = 3;
/** CONTROL frames accepted before the control socket exists (flushed after METADATA). */
const PENDING_CONTROL_MAX = 64;
const RESET_VIDEO_MSG = new Uint8Array([ControlMsg.RESET_VIDEO]);

interface StreamPrepared {
  options: StreamOptions;
}

class StreamSession {
  private adb: Adb | undefined;
  private process: AdbNoneProtocolProcess | undefined;
  private tunnelName: string | undefined;
  private reverseAdded = false;
  private tunnel: ReverseTunnel | undefined;
  private readonly sockets: AdbSocket[] = [];
  private readonly readers: SocketReader[] = [];
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private readonly pendingControl: Uint8Array[] = [];
  private readonly congestion = new CongestionController();
  private gotConfig = false;
  private stallTimer: Timer | undefined;
  private stallResets = 0;
  private released = false;
  private width = 0;
  private height = 0;

  constructor(
    private readonly ws: AppSocket,
    private readonly options: StreamOptions,
    private readonly service: AdbService,
    private readonly services: AppServices,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    const { serial } = this.options;
    try {
      const adb = await this.service.getAdb(serial);
      this.adb = adb;
      const sdk = await this.service.getSdk(serial);
      const jarPath = await this.services.scrcpyServerPath();

      let audioEnabled = this.options.audio;
      if (sdk < 30 && audioEnabled) {
        this.log.info(`${serial}: SDK ${sdk} < 30, audio disabled`);
        audioEnabled = false;
      }
      if (sdk < 33 && audioEnabled && this.options.audioSource === "playback") {
        this.log.info(`${serial}: SDK ${sdk} < 33, playback source unavailable, audio disabled`);
        audioEnabled = false;
      }
      let audioCodec = audioEnabled ? this.options.audioCodec : undefined;
      if (audioCodec !== undefined) {
        const encoders = await audioEncodersFor(this.service, serial, jarPath, this.log);
        const chosen = chooseAudioCodec(audioCodec, encoders);
        if (chosen !== audioCodec)
          this.log.info(
            `${serial}: audio codec ${audioCodec} → ${chosen ?? "disabled"} (encoders: ${encoders.join(", ")})`,
          );
        audioCodec = chosen;
      }
      if (this.released) return;

      await ensureServerJar(adb, jarPath, this.log);
      if (this.released) return;

      // Reverse needs adbd to reach our listener through the adb server's loopback, which only
      // works when that server runs on this host; a remote ADB_SERVER must use forward.
      const launch: LaunchOptions = {
        scid: randomScid(),
        tunnelForward: sdk < 28 || this.services.config.adbServer !== undefined,
        cleanup: sdk >= 28,
        video: this.options,
        audioCodec,
      };
      this.tunnelName = `localabstract:scrcpy_${launch.scid}`;
      const expected = 2 + (audioCodec === undefined ? 0 : 1);

      if (!launch.tunnelForward) {
        this.tunnel = new ReverseTunnel(this.tunnelName);
        await adb.reverse.addExternal(this.tunnelName, this.tunnel.localAddress);
        this.reverseAdded = true;
        if (this.released) {
          this.teardownDevice();
          return;
        }
      }

      const command = buildServerCommand(serializeServerOptions(launch));
      this.log.info(`${serial}: launching ${command.slice(4).join(" ")}`);
      const process = await adb.subprocess.noneProtocol.spawn(command);
      this.process = process;
      if (this.released) {
        this.teardownDevice();
        return;
      }
      void this.teeOutput(process);
      void process.exited.then(() => {
        if (this.released) return;
        this.log.warn(`${serial}: scrcpy-server exited`);
        this.fail("scrcpy-server exited");
      });

      if (this.tunnel) await this.acceptReverse(this.tunnel, expected);
      else await this.connectForward(adb, this.tunnelName, expected);
      if (this.released) return;
      const [videoSocket, maybeAudio, maybeControl] = this.sockets;
      const audioSocket = audioCodec === undefined ? undefined : maybeAudio;
      const controlSocket = audioCodec === undefined ? maybeAudio : maybeControl;
      if (!videoSocket || !controlSocket) throw new Error("tunnel delivered fewer sockets than expected");

      const video = new SocketReader(videoSocket);
      this.readers.push(video);
      const deviceName = decodeDeviceName(await video.read(DEVICE_NAME_FIELD_LENGTH));
      const audio = audioSocket ? new SocketReader(audioSocket) : undefined;
      if (audio) this.readers.push(audio);

      const [videoHeader, audioHeader] = await Promise.all([
        this.readVideoHeader(video),
        audio ? audio.read(4).then(readU32) : Promise.resolve(AUDIO_DISABLED),
      ]);
      if (this.released) return;

      const audioCodecName: StreamMetadata["audioCodec"] =
        audioHeader === AUDIO_DISABLED
          ? "disabled"
          : audioHeader === AUDIO_ERROR
            ? "error"
            : (AUDIO_CODEC_IDS[audioHeader] ?? "error");
      if (audio && audioHeader !== AUDIO_DISABLED && AUDIO_CODEC_IDS[audioHeader] === undefined) {
        this.log.warn(
          `${serial}: audio socket opened with ${audioHeader === AUDIO_ERROR ? "config error" : `unknown codec id 0x${audioHeader.toString(16)}`}`,
        );
      }
      const metadata: StreamMetadata = {
        deviceName,
        videoCodec: videoHeader.codec,
        audioCodec: audioCodecName,
        width: this.width,
        height: this.height,
      };
      if (this.options.videoEncoder !== undefined) metadata.videoEncoder = this.options.videoEncoder;
      this.ws.send(buildJsonFrame(ChannelId.METADATA, metadata));
      this.log.info(
        `${serial}: stream up (${deviceName}, ${metadata.videoCodec} ${this.width}x${this.height}, audio ${audioCodecName})`,
      );

      this.controlWriter = controlSocket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
      for (const message of this.pendingControl.splice(0)) this.writeControl(message);
      this.armStallTimer();

      const loops = [this.videoLoop(video), this.deviceMessageLoop(controlSocket)];
      if (audio && audioHeader !== AUDIO_DISABLED && audioHeader !== AUDIO_ERROR) loops.push(this.audioLoop(audio));
      else if (audio) void audio.cancel();
      await Promise.race(loops);
      if (!this.released) {
        this.log.info(`${serial}: stream ended by device`);
        this.release();
        if (this.ws.readyState <= 1) this.ws.close();
      }
    } catch (error) {
      if (this.released) return;
      this.log.warn(`${serial}: stream failed: ${describe(error)}`);
      this.fail(describe(error));
    }
  }

  private async readVideoHeader(video: SocketReader): Promise<{ codec: StreamMetadata["videoCodec"] }> {
    const id = readU32(await video.read(4));
    const codec = VIDEO_CODEC_IDS[id];
    if (codec === undefined) throw new Error(`unknown video codec id 0x${id.toString(16)}`);
    const head = parseFrameHeader(await video.read(8));
    if (head.kind !== "session") throw new Error("video stream did not start with a session packet");
    this.width = head.width;
    this.height = readU32(await video.read(4));
    return { codec };
  }

  /** Sockets land in `this.sockets` as they arrive so `release()` can close them after a timeout. */
  private async acceptReverse(tunnel: ReverseTunnel, expected: number): Promise<void> {
    while (this.sockets.length < expected && !this.released) this.sockets.push(await tunnel.next(ACCEPT_TIMEOUT_MS));
  }

  /** SDK < 28 or remote adb server: connect to the device-side listener; first socket carries a dummy 0x00 byte. */
  private async connectForward(adb: Adb, name: string, expected: number): Promise<void> {
    const deadline = Date.now() + FORWARD_CONNECT_DEADLINE_MS;
    while (this.sockets.length < expected && !this.released) {
      try {
        const socket = await adb.createSocket(name);
        if (this.sockets.length === 0) {
          const probe = new SocketReader(socket);
          const dummy = await Promise.race([
            probe.read(1),
            Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
          ]);
          if (dummy === undefined) {
            void socket.close();
            throw new Error("scrcpy-server did not send its dummy byte in time");
          }
          // Hand the already-buffered stream back as a socket so later reads see the device name next.
          this.sockets.push(wrapBuffered(socket, probe));
        } else {
          this.sockets.push(socket);
        }
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`forward tunnel connect timed out: ${describe(error)}`);
        await Bun.sleep(FORWARD_RETRY_MS);
      }
    }
  }

  private async teeOutput(process: AdbNoneProtocolProcess): Promise<void> {
    const reader = process.output.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.log.info(`${this.options.serial} [server] ${line}`);
      }
      if (carry.trim()) this.log.info(`${this.options.serial} [server] ${carry}`);
    } catch {
      // process socket closed
    }
  }

  private async videoLoop(video: SocketReader): Promise<void> {
    for (;;) {
      const head = await video.read(8);
      const header = parseFrameHeader(head);
      if (header.kind === "session") {
        this.width = header.width;
        this.height = readU32(await video.read(4));
        const change: SessionChange = { width: this.width, height: this.height };
        this.ws.send(buildJsonFrame(ChannelId.SESSION, change));
        continue;
      }
      const sizeBytes = await video.read(4);
      const payload = await video.read(readU32(sizeBytes));
      if (header.config && !this.gotConfig) {
        this.gotConfig = true;
        clearTimeout(this.stallTimer);
      }
      const decision = this.congestion.decide(this.ws.getBufferedAmount(), {
        channel: "video",
        config: header.config,
        keyframe: header.keyframe,
      });
      if (decision.event) this.logCongestion(decision.event);
      if (decision.reset) this.writeControl(RESET_VIDEO_MSG);
      if (decision.send) this.ws.send(buildMediaFrame(ChannelId.VIDEO, head, sizeBytes, payload));
    }
  }

  private async audioLoop(audio: SocketReader): Promise<void> {
    for (;;) {
      const head = await audio.read(8);
      const header = parseFrameHeader(head);
      if (header.kind === "session") throw new Error("session packet on audio socket");
      const sizeBytes = await audio.read(4);
      const payload = await audio.read(readU32(sizeBytes));
      const decision = this.congestion.decide(this.ws.getBufferedAmount(), {
        channel: "audio",
        config: header.config,
        keyframe: false,
      });
      if (decision.event) this.logCongestion(decision.event);
      if (decision.reset) this.writeControl(RESET_VIDEO_MSG);
      if (decision.send) this.ws.send(buildMediaFrame(ChannelId.AUDIO, head, sizeBytes, payload));
    }
  }

  private async deviceMessageLoop(control: AdbSocket): Promise<void> {
    const reader = control.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const frame = new Uint8Array(1 + value.byteLength);
      frame[0] = ChannelId.DEVICE_MSG;
      frame.set(value, 1);
      this.ws.send(frame);
    }
  }

  private logCongestion(event: "congested" | "drained" | "resumed"): void {
    const buffered = this.ws.getBufferedAmount();
    if (event === "congested")
      this.log.warn(`${this.options.serial}: browser congested (${buffered} B buffered), shedding media`);
    else if (event === "drained")
      this.log.info(`${this.options.serial}: drained to ${buffered} B, requesting keyframe`);
    else this.log.info(`${this.options.serial}: resumed after dropping ${this.congestion.dropped} packets`);
  }

  private armStallTimer(): void {
    this.stallTimer = setTimeout(() => {
      if (this.gotConfig || this.released) return;
      this.stallResets += 1;
      this.log.warn(
        `${this.options.serial}: no config packet after ${STALL_TIMEOUT_MS / 1000} s, RESET_VIDEO (${this.stallResets}/${STALL_MAX_RESETS})`,
      );
      this.writeControl(RESET_VIDEO_MSG);
      if (this.stallResets < STALL_MAX_RESETS) {
        this.stallTimer = setTimeout(() => this.armStallTimerRetry(), STALL_RETRY_MS);
      }
    }, STALL_TIMEOUT_MS);
  }

  private armStallTimerRetry(): void {
    if (this.gotConfig || this.released) return;
    this.stallResets += 1;
    this.log.warn(
      `${this.options.serial}: still no config packet, RESET_VIDEO (${this.stallResets}/${STALL_MAX_RESETS})`,
    );
    this.writeControl(RESET_VIDEO_MSG);
    if (this.stallResets < STALL_MAX_RESETS)
      this.stallTimer = setTimeout(() => this.armStallTimerRetry(), STALL_RETRY_MS);
  }

  /**
   * Browser CONTROL frame payload (channel byte already stripped) → control socket. Frames that
   * arrive before the control socket exists are queued (bounded) and flushed after METADATA.
   */
  writeControl(message: Uint8Array): void {
    if (this.released) return;
    if (!this.controlWriter) {
      if (this.pendingControl.length < PENDING_CONTROL_MAX) this.pendingControl.push(message);
      else this.log.debug(`${this.options.serial}: control queue full before METADATA, dropping frame`);
      return;
    }
    this.controlWriter.write(message).catch((error: unknown) => {
      if (!this.released) this.log.debug(`${this.options.serial}: control write failed: ${describe(error)}`);
    });
  }

  private fail(reason: string): void {
    this.release();
    closeWith(this.ws, WsClose.SESSION_FAILED, reason);
  }

  /** Tear down device-side resources; idempotent. Does not close the WebSocket. */
  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.stallTimer);
    this.pendingControl.length = 0;
    void this.controlWriter?.close().catch(() => undefined);
    this.teardownDevice();
  }

  /**
   * Close everything created so far; safe to call repeatedly. Also used mid-`start()` when
   * `release()` ran while an await was pending, so the step that just finished gets undone too.
   */
  private teardownDevice(): void {
    for (const reader of this.readers.splice(0)) void reader.cancel();
    for (const socket of this.sockets.splice(0)) void Promise.resolve(socket.close()).catch(() => undefined);
    this.tunnel?.close();
    const { adb, tunnelName, process } = this;
    if (adb && tunnelName && this.reverseAdded) {
      this.reverseAdded = false;
      void adb.reverse.remove(tunnelName).catch(() => undefined);
    }
    if (process) {
      this.process = undefined;
      void Promise.resolve(process.kill()).catch(() => undefined);
    }
  }
}

/** Replace a socket's readable with the buffered reader that already consumed the dummy byte. */
function wrapBuffered(socket: AdbSocket, reader: SocketReader): AdbSocket {
  return {
    get service() {
      return socket.service;
    },
    readable: reader.release(),
    writable: socket.writable,
    get closed() {
      return socket.closed;
    },
    close: () => socket.close(),
  };
}

export function registerStream(router: AppRouter, service: AdbService, services: AppServices): void {
  const log = services.log("stream");
  const releaseSession = (ws: AppSocket): void => {
    const session = ws.data.state;
    if (session instanceof StreamSession) session.release();
  };
  const live = new LiveSockets(services, releaseSession);
  router.ws(
    "/ws/stream",
    "auth",
    (ctx: RequestContext): StreamPrepared => {
      const options = parseStreamQuery(ctx.url.searchParams);
      if (!options) throw new HttpError(400, "invalid serial");
      return { options };
    },
    {
      open(ws: AppSocket) {
        const { options } = ws.data.state as StreamPrepared;
        const session = new StreamSession(ws, options, service, services, log);
        ws.data.state = session;
        live.add(ws);
        void session.start();
      },
      message(ws: AppSocket, data: string | Buffer) {
        if (typeof data === "string") return;
        if (data.byteLength < 2 || data[0] !== ChannelId.CONTROL) return;
        (ws.data.state as StreamSession).writeControl(
          new Uint8Array(data.buffer, data.byteOffset + 1, data.byteLength - 1),
        );
      },
      close(ws: AppSocket) {
        live.delete(ws);
        releaseSession(ws);
      },
    },
  );
}
