/**
 * Loopback-only TCP listener for the scrcpy reverse tunnel. The device side is registered with
 * `adb.reverse.addExternal(name, tunnel.localAddress)`; adbd then opens one connection per
 * scrcpy socket (video, audio, control) and we hand them out in arrival order. Tango's own
 * `reverse.add` listens on every interface, which is why this exists.
 */

import type { AdbSocket } from "@yume-chan/adb";
import { MaybeConsumable, PushReadableStream, type PushReadableStreamController } from "@yume-chan/stream-extra";

const LOOPBACK = "127.0.0.1";

type BunSocket = Bun.Socket<TcpTunnelSocket | undefined>;

/** Adapts one accepted Bun TCP socket to the `AdbSocket` shape the stream readers expect. */
class TcpTunnelSocket implements AdbSocket {
  readonly readable: PushReadableStream<Uint8Array>;
  readonly writable: MaybeConsumable.WritableStream<Uint8Array>;
  readonly closed: Promise<undefined>;
  private controller: PushReadableStreamController<Uint8Array> | undefined;
  private resolveClosed: (() => void) | undefined;
  private drainWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private ended = false;

  constructor(
    readonly service: string,
    private readonly socket: BunSocket,
  ) {
    this.closed = new Promise<undefined>((resolve) => {
      this.resolveClosed = () => resolve(undefined);
    });
    this.readable = new PushReadableStream<Uint8Array>((controller) => {
      this.controller = controller;
      if (this.ended) controller.close();
    });
    this.writable = new MaybeConsumable.WritableStream<Uint8Array>({
      write: (chunk) => this.writeAll(chunk),
      close: () => {
        this.socket.end();
      },
      abort: () => {
        this.socket.end();
      },
    });
  }

  close(): void {
    this.socket.end();
  }

  /** Bun `data` handler: pause the socket while the consumer's queue is full. */
  async onData(data: Uint8Array): Promise<void> {
    const controller = this.controller;
    if (!controller || controller.abortSignal.aborted) return;
    const accepted = controller.enqueue(data);
    if (accepted instanceof Promise) {
      this.socket.pause();
      await accepted;
      this.socket.resume();
    }
  }

  onDrain(): void {
    const waiter = this.drainWaiter;
    this.drainWaiter = undefined;
    waiter?.resolve();
  }

  /** Peer half-closed (FIN) or the socket is gone: end the readable, settle `closed`. */
  onEnd(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    const controller = this.controller;
    if (controller && !controller.abortSignal.aborted) {
      try {
        if (error) controller.error(error);
        else controller.close();
      } catch {
        // already closed by the producer
      }
    }
    const waiter = this.drainWaiter;
    this.drainWaiter = undefined;
    waiter?.reject(error ?? new Error("tunnel socket closed"));
  }

  onClose(error?: Error): void {
    this.onEnd(error);
    this.resolveClosed?.();
  }

  private async writeAll(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.ended || this.socket.readyState !== 1) throw new Error("tunnel socket closed");
      const written = this.socket.write(chunk, offset);
      if (written < 0) throw new Error("tunnel socket write failed");
      offset += written;
      if (offset < chunk.byteLength) {
        await new Promise<void>((resolve, reject) => {
          this.drainWaiter = { resolve, reject };
        });
      }
    }
  }
}

/** Loopback listener plus the arrival-ordered queue of sockets the device opened through it. */
export class ReverseTunnel {
  private readonly listener: Bun.TCPSocketListener<TcpTunnelSocket | undefined>;
  private readonly queue: AdbSocket[] = [];
  private readonly waiters: ((socket: AdbSocket) => void)[] = [];
  private stopped = false;

  constructor(readonly deviceAddress: string) {
    this.listener = Bun.listen<TcpTunnelSocket | undefined>({
      hostname: LOOPBACK,
      port: 0,
      socket: {
        open: (socket) => {
          const wrapped = new TcpTunnelSocket(deviceAddress, socket);
          socket.data = wrapped;
          socket.setNoDelay(true);
          this.push(wrapped);
        },
        data: (socket, data) => socket.data?.onData(data),
        drain: (socket) => socket.data?.onDrain(),
        end: (socket) => socket.data?.onEnd(),
        close: (socket, error) => socket.data?.onClose(error),
        error: (socket, error) => socket.data?.onEnd(error),
      },
    });
  }

  /** `tcp:<port>` for `adb reverse`; adb's own loopback connect falls back to IPv4. */
  get localAddress(): string {
    return `tcp:${this.listener.port}`;
  }

  /** Next accepted socket in arrival order; rejects after `timeoutMs`. */
  next(timeoutMs: number): Promise<AdbSocket> {
    const ready = this.queue.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise<AdbSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(settle);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`scrcpy-server did not connect within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const settle = (socket: AdbSocket): void => {
        clearTimeout(timer);
        resolve(socket);
      };
      this.waiters.push(settle);
    });
  }

  /** Stop accepting and close anything nobody took out of the queue. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.listener.stop();
    for (const socket of this.queue.splice(0)) void Promise.resolve(socket.close()).catch(() => undefined);
  }

  private push(socket: AdbSocket): void {
    if (this.stopped) {
      void Promise.resolve(socket.close()).catch(() => undefined);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(socket);
    else this.queue.push(socket);
  }
}
