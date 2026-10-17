/**
 * Device capability probe: screen size/density and MediaCodec encoder names.
 * `/ws/probe?serial=` sends one ProbeResult then closes.
 */
import type { Adb } from "@yume-chan/adb";
import { WsClose, type ProbeResult } from "@common/protocol.ts";
import { isSerial } from "@common/validate.ts";
import { HttpError, type AppRouter, type AppServices, type AppSocket, type Logger, type RequestContext } from "../app.ts";
import { ensureServerJar } from "./jar.ts";
import { buildServerCommand } from "./options.ts";
import { describe, type AdbService } from "./service.ts";
import { closeWith } from "./ws.ts";

export interface EncoderLists {
  video: string[];
  audio: string[];
}

export function parseWmSize(output: string): { width: number; height: number } | undefined {
  const match = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(output);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseWmDensity(output: string): number | undefined {
  const match = /(?:Override|Physical) density:\s*(\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

const VIDEO_NAME_HINTS = ["avc", "h264", "hevc", "h265", "av1", "vp8", "vp9"];
const AUDIO_NAME_HINTS = ["opus", "aac", "flac"];

/** `dumpsys media.player` lists `Encoder "<name>" supports ...` for every MediaCodec encoder. */
export function parseDumpsysEncoders(output: string): EncoderLists {
  const lists: EncoderLists = { video: [], audio: [] };
  const regex = /Encoder "([^"]+)" supports/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1] ?? "";
    const lower = name.toLowerCase();
    if (VIDEO_NAME_HINTS.some((hint) => lower.includes(hint))) {
      if (!lists.video.includes(name)) lists.video.push(name);
    } else if (AUDIO_NAME_HINTS.some((hint) => lower.includes(hint))) {
      if (!lists.audio.includes(name)) lists.audio.push(name);
    }
  }
  return lists;
}

/** scrcpy `list_encoders=true` output: `--video-encoder=<name>` / `--audio-encoder=<name>` lines. */
export function parseScrcpyEncoderList(output: string): EncoderLists {
  const lists: EncoderLists = { video: [], audio: [] };
  for (const [regex, target] of [
    [/--video-encoder=(\S+)/g, lists.video],
    [/--audio-encoder=(\S+)/g, lists.audio],
  ] as const) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      const name = match[1] ?? "";
      if (!target.includes(name)) target.push(name);
    }
  }
  return lists;
}

async function listEncoders(adb: Adb, sdk: number, scrcpyServerPath: string, log: Logger): Promise<EncoderLists> {
  const shell = adb.subprocess.noneProtocol;
  if (sdk >= 28) return parseDumpsysEncoders(await shell.spawnWaitText("dumpsys media.player"));
  await ensureServerJar(adb, scrcpyServerPath, log);
  return parseScrcpyEncoderList(await shell.spawnWaitText(buildServerCommand(["list_encoders=true", "cleanup=false"])));
}

/** Full probe; cached per serial until the device disappears. */
export async function probeDevice(service: AdbService, serial: string, scrcpyServerPath: string, log: Logger): Promise<ProbeResult> {
  const cache = service.cacheFor(serial);
  if (cache.probe) return cache.probe;
  const adb = await service.getAdb(serial);
  const sdk = await service.getSdk(serial);
  const shell = adb.subprocess.noneProtocol;
  const [sizeOut, densityOut, encoders] = await Promise.all([
    shell.spawnWaitText("wm size"),
    shell.spawnWaitText("wm density"),
    listEncoders(adb, sdk, scrcpyServerPath, log),
  ]);
  const size = parseWmSize(sizeOut) ?? { width: 0, height: 0 };
  const result: ProbeResult = {
    width: size.width,
    height: size.height,
    density: parseWmDensity(densityOut) ?? 0,
    sdk,
    videoEncoders: encoders.video,
    audioEncoders: encoders.audio,
  };
  cache.probe = result;
  cache.audioEncoders = Promise.resolve(encoders.audio);
  return result;
}

/** Audio encoder names only (for codec fallback); [] when unknown. Never throws. */
export function audioEncodersFor(service: AdbService, serial: string, scrcpyServerPath: string, log: Logger): Promise<string[]> {
  const cache = service.cacheFor(serial);
  if (cache.audioEncoders) return cache.audioEncoders;
  const pending = (async () => {
    const adb = await service.getAdb(serial);
    const sdk = await service.getSdk(serial);
    return (await listEncoders(adb, sdk, scrcpyServerPath, log)).audio;
  })().catch((error: unknown) => {
    log.warn(`audio encoder probe failed for ${serial}: ${describe(error)}`);
    if (cache.audioEncoders === pending) cache.audioEncoders = undefined;
    return [] as string[];
  });
  cache.audioEncoders = pending;
  return pending;
}

interface ProbeState {
  serial: string;
}

export function registerProbe(router: AppRouter, service: AdbService, services: AppServices): void {
  const log = services.log("probe");
  router.ws(
    "/ws/probe",
    "auth",
    (ctx: RequestContext): ProbeState => {
      const serial = ctx.url.searchParams.get("serial");
      if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
      return { serial };
    },
    {
      async open(ws: AppSocket) {
        const { serial } = ws.data.state as ProbeState;
        try {
          const result = await probeDevice(service, serial, await services.scrcpyServerPath(), log);
          ws.send(JSON.stringify(result));
          closeWith(ws, WsClose.NORMAL);
        } catch (error) {
          log.warn(`probe failed for ${serial}: ${describe(error)}`);
          closeWith(ws, WsClose.SESSION_FAILED, describe(error));
        }
      },
      message() {},
      close() {},
    },
  );
}
