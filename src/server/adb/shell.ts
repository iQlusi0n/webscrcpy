/**
 * `/ws/shell?serial=…` — device-side PTY over `shell,v2,pty:` (D10). Binary frames are raw
 * terminal bytes in both directions; text frames carry ShellClientMessage / ShellServerMessage.
 */

import { type ShellClientMessage, type ShellServerMessage, WsClose } from "@common/protocol.ts";
import { isSerial, parseIntInRange } from "@common/validate.ts";
import { type AdbNoneProtocolPtyProcess, AdbShellProtocolPtyProcess } from "@yume-chan/adb";
import type { WritableStreamDefaultWriter } from "@yume-chan/stream-extra";
import {
  type AppRouter,
  type AppServices,
  type AppSocket,
  HttpError,
  type Logger,
  type RequestContext,
} from "../app.ts";
import { type AdbService, describe } from "./service.ts";
import { closeWith, LiveSockets } from "./ws.ts";

const TERMINAL_TYPE = "xterm-256color";

interface ShellState {
  serial: string;
  /** set synchronously on the first `start` so a second one can't open another PTY */
  starting: boolean;
  pty?: AdbShellProtocolPtyProcess | AdbNoneProtocolPtyProcess;
  input?: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
}

function parseClientMessage(text: string): ShellClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { type, cols, rows } = parsed as Record<string, unknown>;
  const c = parseIntInRange(cols, 1, 1000);
  const r = parseIntInRange(rows, 1, 1000);
  if ((type !== "start" && type !== "resize") || c === undefined || r === undefined) return undefined;
  return { type, cols: c, rows: r };
}

async function startPty(
  ws: AppSocket,
  state: ShellState,
  service: AdbService,
  cols: number,
  rows: number,
  log: Logger,
): Promise<void> {
  const adb = await service.getAdb(state.serial);
  if (state.closed) return;
  const shellProtocol = adb.subprocess.shellProtocol;
  if (shellProtocol) {
    const pty = await shellProtocol.pty({ terminalType: TERMINAL_TYPE });
    state.pty = pty;
    await pty.resize(rows, cols);
  } else {
    log.warn(`${state.serial}: device lacks shell_v2; falling back to legacy pty (no resize, no exit code)`);
    state.pty = await adb.subprocess.noneProtocol.pty();
  }
  if (state.closed) {
    await state.pty.kill();
    return;
  }
  const pty = state.pty;
  state.input = pty.input.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  // Drain stdout to EOF first: the exit code is reported only after the last output has been sent.
  const reader = pty.output.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || state.closed) break;
      ws.send(value);
    }
  } catch (error) {
    if (!state.closed) log.debug(`${state.serial}: pty output ended: ${describe(error)}`);
  }
  if (state.closed) return;
  try {
    const code = await pty.exited;
    if (state.closed) return;
    const message: ShellServerMessage = { type: "exit", code: code ?? 0 };
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
    state.closed = true;
    closeWith(ws, WsClose.NORMAL);
  } catch (error) {
    if (state.closed) return;
    state.closed = true;
    closeWith(ws, WsClose.SESSION_FAILED, describe(error));
  }
}

function closeShell(state: ShellState): void {
  if (state.closed) return;
  state.closed = true;
  void state.input?.close().catch(() => undefined);
  if (state.pty) void Promise.resolve(state.pty.kill()).catch(() => undefined);
}

export function registerShell(router: AppRouter, service: AdbService, services: AppServices): void {
  const log = services.log("shell");
  const live = new LiveSockets(services, (ws) => closeShell(ws.data.state as ShellState));
  router.ws(
    "/ws/shell",
    "auth",
    (ctx: RequestContext): ShellState => {
      const serial = ctx.url.searchParams.get("serial");
      if (!isSerial(serial)) throw new HttpError(400, "invalid serial");
      return { serial, starting: false, closed: false };
    },
    {
      open(ws: AppSocket) {
        live.add(ws);
      },
      message(ws: AppSocket, data: string | Buffer) {
        const state = ws.data.state as ShellState;
        if (state.closed) return;
        if (typeof data !== "string") {
          state.input?.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).catch(() => undefined);
          return;
        }
        const message = parseClientMessage(data);
        if (!message) return;
        if (message.type === "start") {
          if (state.starting) return;
          state.starting = true;
          void startPty(ws, state, service, message.cols, message.rows, log).catch((error: unknown) => {
            if (state.closed) return;
            state.closed = true;
            log.warn(`${state.serial}: shell failed: ${describe(error)}`);
            closeWith(ws, WsClose.SESSION_FAILED, describe(error));
          });
        } else {
          if (state.pty instanceof AdbShellProtocolPtyProcess)
            void state.pty.resize(message.rows, message.cols).catch(() => undefined);
        }
      },
      close(ws: AppSocket) {
        live.delete(ws);
        closeShell(ws.data.state as ShellState);
      },
    },
  );
}
