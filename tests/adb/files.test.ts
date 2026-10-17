import { describe, expect, test } from "bun:test";
import type { FilesResponse } from "@common/protocol.ts";
import type { AdbSync, AdbSyncStat } from "@yume-chan/adb";
import { registerFiles } from "../../src/server/adb/files.ts";
import type { AdbService } from "../../src/server/adb/service.ts";
import type { AppRouter, AppServices, AppSocket, RequestContext, WsHandlers } from "../../src/server/app.ts";

const STAT = { mode: 0o100644, size: 3n, mtime: 1n } as AdbSyncStat;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeSync {
  sync: AdbSync;
  disposed: number;
  lstatCalls: string[];
  lstatResults: (AdbSyncStat | Error)[];
  writeCalls: number;
  writeDone: Deferred<void>;
}

function fakeSync(): FakeSync {
  const fake: FakeSync = {
    sync: {} as AdbSync,
    disposed: 0,
    lstatCalls: [],
    lstatResults: [],
    writeCalls: 0,
    writeDone: deferred<void>(),
  };
  fake.sync = {
    async lstat(path: string) {
      fake.lstatCalls.push(path);
      const next = fake.lstatResults.shift() ?? STAT;
      if (next instanceof Error) throw next;
      return next;
    },
    write() {
      fake.writeCalls += 1;
      return fake.writeDone.promise;
    },
    async dispose() {
      fake.disposed += 1;
    },
  } as unknown as AdbSync;
  return fake;
}

interface Harness {
  sent: FilesResponse[];
  syncs: FakeSync[];
  /** resolve to let `getAdb` complete */
  gate: Deferred<void>;
  send(request: object): Promise<void>;
  flush(): Promise<void>;
}

function harness(): Harness {
  let registered: { prepare: (ctx: RequestContext) => unknown; handlers: WsHandlers } | undefined;
  const router: AppRouter = {
    route() {},
    ws(_path, _gate, prepare, handlers) {
      registered = { prepare, handlers };
    },
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const services = { log: () => log } as unknown as AppServices;
  const syncs: FakeSync[] = [];
  const gate = deferred<void>();
  const service = {
    getAdb: async () => {
      await gate.promise;
      return {
        sync: async () => {
          const next = fakeSync();
          syncs.push(next);
          return next.sync;
        },
      };
    },
  } as unknown as AdbService;
  registerFiles(router, service, services);
  if (!registered) throw new Error("registerFiles did not register a ws endpoint");
  const { prepare, handlers } = registered;

  const sent: FilesResponse[] = [];
  const ws = {
    readyState: 1,
    data: { kind: "files", state: undefined as unknown },
    send(message: string | Uint8Array) {
      if (typeof message === "string") sent.push(JSON.parse(message) as FilesResponse);
    },
    getBufferedAmount: () => 0,
    close() {},
  } as unknown as AppSocket;
  // prepare() builds the per-socket state exactly like the real upgrade path
  ws.data.state = prepare({ url: new URL("http://localhost/ws/files?serial=ABC123") } as RequestContext);
  void handlers.open(ws);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return {
    sent,
    syncs,
    gate,
    async send(request) {
      await handlers.message(ws, JSON.stringify(request));
      await flush();
    },
    flush,
  };
}

describe("/ws/files sync lifecycle", () => {
  test("a failed op disposes the sync socket and the next request opens a fresh one", async () => {
    const h = harness();
    h.gate.resolve();
    await h.send({ id: 1, op: "stat", path: "/sdcard/a" });
    expect(h.syncs).toHaveLength(1);
    const first = h.syncs[0];
    if (!first) throw new Error("no sync");
    expect(h.sent.at(-1)).toMatchObject({ id: 1, type: "stat" });

    first.lstatResults.push(new Error("FAIL: permission denied"));
    await h.send({ id: 2, op: "stat", path: "/data/secret" });
    expect(h.sent.at(-1)).toMatchObject({ id: 2, type: "error" });
    expect(first.disposed).toBe(1);

    await h.send({ id: 3, op: "stat", path: "/sdcard/b" });
    expect(h.syncs).toHaveLength(2);
    expect(h.sent.at(-1)).toMatchObject({ id: 3, type: "stat" });
  });

  test("request ids are reserved before the sync socket is ready", async () => {
    const h = harness();
    await h.send({ id: 7, op: "stat", path: "/sdcard/a" });
    await h.send({ id: 7, op: "stat", path: "/sdcard/a" });
    expect(h.sent).toEqual([{ id: 7, type: "error", message: "request id already in flight" }]);

    // cancel while still pending: the op never runs and the id is free again
    await h.send({ id: 7, op: "cancel" });
    h.gate.resolve();
    await h.flush();
    expect(h.syncs[0]?.lstatCalls ?? []).toEqual([]);

    await h.send({ id: 7, op: "stat", path: "/sdcard/c" });
    expect(h.sent.at(-1)).toMatchObject({ id: 7, type: "stat" });
  });

  test("cancelling a push aborts it silently and reopens the sync socket", async () => {
    const h = harness();
    h.gate.resolve();
    await h.send({ id: 4, op: "push", path: "/sdcard/up.bin", size: 10 });
    expect(h.sent.at(-1)).toEqual({ id: 4, type: "ready" });
    const first = h.syncs[0];
    if (!first) throw new Error("no sync");
    expect(first.writeCalls).toBe(1);

    await h.send({ id: 4, op: "cancel" });
    first.writeDone.reject(new Error("aborted"));
    await h.flush();
    expect(first.disposed).toBe(1);
    expect(h.sent.filter((m) => m.id === 4 && m.type === "error")).toEqual([]);

    await h.send({ id: 5, op: "stat", path: "/sdcard/a" });
    expect(h.syncs).toHaveLength(2);
    expect(h.sent.at(-1)).toMatchObject({ id: 5, type: "stat" });
  });
});
