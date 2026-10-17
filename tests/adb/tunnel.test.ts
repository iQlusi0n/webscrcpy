import { describe, expect, test } from "bun:test";
import type { ReadableStream as TangoReadableStream } from "@yume-chan/stream-extra";
import { ReverseTunnel } from "../../src/server/adb/tunnel.ts";

interface Peer {
  received: Uint8Array[];
  /** resolves with the next chunk the peer receives */
  nextChunk: Promise<Uint8Array>;
  notify: (chunk: Uint8Array) => void;
}

function portOf(tunnel: ReverseTunnel): number {
  const match = /^tcp:(\d+)$/.exec(tunnel.localAddress);
  if (!match || match[1] === undefined) throw new Error(`unexpected local address ${tunnel.localAddress}`);
  return Number(match[1]);
}

function connect(port: number, hostname = "127.0.0.1"): Promise<Bun.Socket<Peer>> {
  const peer: Peer = { received: [], nextChunk: Promise.resolve(new Uint8Array()), notify: () => undefined };
  peer.nextChunk = new Promise<Uint8Array>((resolve) => {
    peer.notify = resolve;
  });
  return Bun.connect<Peer>({
    hostname,
    port,
    data: peer,
    socket: {
      data(socket, chunk) {
        const copy = new Uint8Array(chunk);
        socket.data.received.push(copy);
        socket.data.notify(copy);
      },
    },
  });
}

async function readExactly(stream: TangoReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream ended early");
    out.set(value.subarray(0, length - filled), filled);
    filled += value.byteLength;
  }
  reader.releaseLock();
  return out;
}

describe("ReverseTunnel", () => {
  test("hands out connections in arrival order and carries bytes both ways", async () => {
    const tunnel = new ReverseTunnel("localabstract:scrcpy_test");
    try {
      const port = portOf(tunnel);
      const first = await connect(port);
      first.write(new Uint8Array([1, 2, 3]));
      const second = await connect(port);
      second.write(new Uint8Array([9]));

      const a = await tunnel.next(1000);
      const b = await tunnel.next(1000);
      expect(a.service).toBe("localabstract:scrcpy_test");
      expect(await readExactly(a.readable, 3)).toEqual(new Uint8Array([1, 2, 3]));
      expect(await readExactly(b.readable, 1)).toEqual(new Uint8Array([9]));

      const writer = b.writable.getWriter();
      await writer.write(new Uint8Array([7, 7]));
      writer.releaseLock();
      expect(await second.data.nextChunk).toEqual(new Uint8Array([7, 7]));

      first.end();
      second.end();
      await Promise.all([a.closed, b.closed]);
    } finally {
      tunnel.close();
    }
  });

  test("times out when nothing connects", async () => {
    const tunnel = new ReverseTunnel("localabstract:scrcpy_timeout");
    try {
      await expect(tunnel.next(30)).rejects.toThrow(/did not connect/);
    } finally {
      tunnel.close();
    }
  });

  test("listens on IPv4 loopback only and stops accepting after close", async () => {
    const tunnel = new ReverseTunnel("localabstract:scrcpy_loopback");
    const port = portOf(tunnel);
    await expect(connect(port, "::1")).rejects.toBeDefined();
    const ok = await connect(port);
    ok.end();
    tunnel.close();
    await expect(connect(port)).rejects.toBeDefined();
  });
});
