/**
 * `/ws/files?serial=…` — file browser over ADB `sync:` (list/stat/pull/push). One AdbSync per
 * socket; one in-flight operation per request id. Wire shapes: protocol.ts FilesRequest/Response.
 */
import type { AdbSync, AdbSyncStat } from "@yume-chan/adb";
import { TransformStream as TangoTransformStream, type WritableStreamDefaultWriter } from "@yume-chan/stream-extra";
import {
  FILES_BINARY_PREFIX,
  FILES_CHUNK_SIZE,
  type FileEntry,
  type FilesPushEnd,
  type FilesRequest,
  type FilesResponse,
} from "@common/protocol.ts";
import { isDevicePath, isSerial } from "@common/validate.ts";
import { HttpError, type AppRouter, type AppServices, type AppSocket, type Logger, type RequestContext } from "../app.ts";
import { describe, type AdbService } from "./service.ts";
import { DrainWaiter } from "./ws.ts";

const PULL_BACKPRESSURE_BYTES = 1024 * 1024;
const PUSH_PROGRESS_BYTES = 256 * 1024;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface PushOp {
  kind: "push";
  writer: WritableStreamDefaultWriter<Uint8Array>;
  received: number;
  lastProgress: number;
  finished: Promise<void>;
}
interface PullOp {
  kind: "pull";
  cancel(): void;
}
type FileOp = PushOp | PullOp;

interface FilesState {
  serial: string;
  sync?: Promise<AdbSync>;
  ops: Map<number, FileOp>;
  drain: DrainWaiter;
  closed: boolean;
}

export function toFileEntry(name: string, stat: AdbSyncStat): FileEntry {
  const type = stat.mode & S_IFMT;
  return {
    name,
    mode: stat.mode,
    size: Number(stat.size),
    mtime: Number(stat.mtime),
    isDir: type === S_IFDIR,
    isLink: type === S_IFLNK,
  };
}

function parseRequest(text: string): FilesRequest | FilesPushEnd | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { id, op, path, size } = parsed as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 0xffff_ffff) return undefined;
  switch (op) {
    case "cancel":
    case "push-end":
      return { id, op };
    case "list":
    case "stat":
    case "pull":
      return isDevicePath(path) ? { id, op, path } : undefined;
    case "push":
      return isDevicePath(path) && typeof size === "number" && size >= 0 ? { id, op, path, size } : undefined;
    default:
      return undefined;
  }
}

function send(ws: AppSocket, response: FilesResponse): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(response));
}

function prefixed(id: number, chunk: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FILES_BINARY_PREFIX + chunk.byteLength);
  new DataView(frame.buffer).setUint32(0, id, true);
  frame.set(chunk, FILES_BINARY_PREFIX);
  return frame;
}

async function getSync(state: FilesState, service: AdbService): Promise<AdbSync> {
  if (!state.sync) {
    state.sync = service.getAdb(state.serial).then((adb) => adb.sync());
    state.sync.catch(() => {
      state.sync = undefined;
    });
  }
  return state.sync;
}

async function handleList(ws: AppSocket, sync: AdbSync, id: number, path: string): Promise<void> {
  const entries: FileEntry[] = [];
  for await (const entry of sync.opendir(path)) {
    if (entry.name === "." || entry.name === "..") continue;
    entries.push(toFileEntry(entry.name, entry));
  }
  send(ws, { id, type: "list", entries });
}

async function handleStat(ws: AppSocket, sync: AdbSync, id: number, path: string): Promise<void> {
  const stat = await sync.lstat(path);
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  send(ws, { id, type: "stat", entry: toFileEntry(name, stat) });
}

async function handlePull(ws: AppSocket, state: FilesState, sync: AdbSync, id: number, path: string): Promise<void> {
  const reader = sync.read(path).getReader();
  let cancelled = false;
  state.ops.set(id, {
    kind: "pull",
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || cancelled || state.closed) break;
      for (let offset = 0; offset < value.byteLength; offset += FILES_CHUNK_SIZE) {
        await state.drain.waitBelow(ws, PULL_BACKPRESSURE_BYTES);
        if (cancelled || state.closed) return;
        ws.send(prefixed(id, value.subarray(offset, Math.min(offset + FILES_CHUNK_SIZE, value.byteLength))));
      }
    }
    if (!cancelled && !state.closed) send(ws, { id, type: "done" });
  } finally {
    state.ops.delete(id);
  }
}

function handlePush(ws: AppSocket, state: FilesState, sync: AdbSync, id: number, path: string, log: Logger): void {
  const pipe = new TangoTransformStream<Uint8Array, Uint8Array>();
  const writer = pipe.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  const finished = sync
    .write({ filename: path, file: pipe.readable, permission: 0o644, mtime: Math.floor(Date.now() / 1000) })
    .then(() => {
      if (state.ops.get(id)?.kind === "push") send(ws, { id, type: "done" });
    })
    .catch((error: unknown) => {
      log.warn(`${state.serial}: push to ${path} failed: ${describe(error)}`);
      send(ws, { id, type: "error", message: describe(error) });
      void writer.abort(error).catch(() => undefined);
    })
    .finally(() => state.ops.delete(id));
  state.ops.set(id, { kind: "push", writer, received: 0, lastProgress: 0, finished });
  send(ws, { id, type: "ready" });
}

async function dispatch(ws: AppSocket, state: FilesState, service: AdbService, request: FilesRequest | FilesPushEnd, log: Logger): Promise<void> {
  const { id } = request;
  const existing = state.ops.get(id);
  if (request.op === "cancel") {
    if (!existing) return;
    if (existing.kind === "pull") existing.cancel();
    else void existing.writer.abort(new Error("cancelled")).catch(() => undefined);
    state.ops.delete(id);
    return;
  }
  if (request.op === "push-end") {
    if (existing?.kind !== "push") return;
    await existing.writer.close().catch(() => undefined);
    return;
  }
  if (existing) {
    send(ws, { id, type: "error", message: "request id already in flight" });
    return;
  }
  try {
    const sync = await getSync(state, service);
    switch (request.op) {
      case "list":
        await handleList(ws, sync, id, request.path);
        break;
      case "stat":
        await handleStat(ws, sync, id, request.path);
        break;
      case "pull":
        await handlePull(ws, state, sync, id, request.path);
        break;
      case "push":
        handlePush(ws, state, sync, id, request.path, log);
        break;
    }
  } catch (error) {
    state.ops.delete(id);
    send(ws, { id, type: "error", message: describe(error) });
  }
}

export function registerFiles(router: AppRouter, service: AdbService, services: AppServices): void {
  const log = services.log("files");
  router.ws(
    "/ws/files",
    "auth",
    (ctx: RequestContext): FilesState => {
      const serial = ctx.url.searchParams.get("serial");
      if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
      return { serial, ops: new Map(), drain: new DrainWaiter(), closed: false };
    },
    {
      open() {},
      message(ws: AppSocket, data: string | Buffer) {
        const state = ws.data.state as FilesState;
        if (state.closed) return;
        if (typeof data === "string") {
          const request = parseRequest(data);
          if (!request) {
            send(ws, { id: -1, type: "error", message: "malformed request" });
            return;
          }
          void dispatch(ws, state, service, request, log);
          return;
        }
        if (data.byteLength < FILES_BINARY_PREFIX) return;
        const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
        const op = state.ops.get(id);
        if (op?.kind !== "push") return;
        const chunk = new Uint8Array(data.buffer, data.byteOffset + FILES_BINARY_PREFIX, data.byteLength - FILES_BINARY_PREFIX);
        op.received += chunk.byteLength;
        op.writer.write(chunk.slice()).catch(() => undefined);
        if (op.received - op.lastProgress >= PUSH_PROGRESS_BYTES) {
          op.lastProgress = op.received;
          send(ws, { id, type: "progress", bytes: op.received });
        }
      },
      drain(ws: AppSocket) {
        (ws.data.state as FilesState).drain.onDrain();
      },
      close(ws: AppSocket) {
        const state = ws.data.state as FilesState;
        state.closed = true;
        for (const op of state.ops.values()) {
          if (op.kind === "pull") op.cancel();
          else void op.writer.abort(new Error("socket closed")).catch(() => undefined);
        }
        state.ops.clear();
        void state.sync?.then((sync) => sync.dispose()).catch(() => undefined);
      },
    },
  );
}
