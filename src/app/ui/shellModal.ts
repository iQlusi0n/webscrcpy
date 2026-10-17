import "@xterm/xterm/css/xterm.css";
import type { DeviceDescriptor, ShellClientMessage, ShellServerMessage } from "@common/protocol.ts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { wsUrl } from "../api.ts";
import { ConfirmModal } from "./confirm.ts";
import { deviceDisplayName } from "./deviceCard.ts";
import { Modal } from "./modal.ts";

/** xterm.js over /ws/shell. Escape/backdrop are ignored; × asks when a session is live. */
export class ShellModal extends Modal {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly container = document.createElement("div");
  private readonly status = document.createElement("div");
  private ws: WebSocket | null = null;
  private started = false;
  private exited = false;
  private readonly observer = new ResizeObserver(() => this.resize());
  private readonly encoder = new TextEncoder();

  constructor(private readonly device: DeviceDescriptor) {
    super({ title: `Shell — ${deviceDisplayName(device)}`, className: "modal-wide", dismissible: false });
    this.body.className = "modal-body shell-body";
    this.container.className = "shell-terminal";
    this.status.className = "modal-status";
    this.body.appendChild(this.container);
    this.footer.appendChild(this.status);
    this.term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false });
    this.term.loadAddon(this.fit);
  }

  protected override onOpen(): void {
    this.term.open(this.container);
    this.fit.fit();
    this.term.focus();
    this.connect();
    this.observer.observe(this.container);
  }

  private send(msg: ShellClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    this.status.textContent = "connecting…";
    const ws = new WebSocket(wsUrl("/ws/shell", { serial: this.device.serial }));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.fit.fit();
      this.send({ type: "start", cols: this.term.cols, rows: this.term.rows });
      this.started = true;
      this.status.textContent = `${this.term.cols}×${this.term.rows}`;
    });
    ws.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg: ShellServerMessage;
      try {
        msg = JSON.parse(ev.data) as ShellServerMessage;
      } catch {
        return;
      }
      if (msg.type === "exit") this.onExit(`exited (${msg.code})`);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.exited) this.onExit(ev.code === 1000 ? "session closed" : `disconnected (${ev.reason || ev.code})`);
    });
    this.term.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.encoder.encode(data));
    });
    this.term.onBinary((data) => {
      // xterm passes raw byte strings here (e.g. mouse reports); send them byte-for-byte.
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.ws.send(bytes);
    });
  }

  private onExit(text: string): void {
    this.exited = true;
    this.status.textContent = text;
    this.term.write(`\r\n\x1b[90m[${text}]\x1b[0m\r\n`);
  }

  private resize(): void {
    if (!this.term.element) return;
    this.fit.fit();
    if (this.started && !this.exited) {
      this.send({ type: "resize", cols: this.term.cols, rows: this.term.rows });
      this.status.textContent = `${this.term.cols}×${this.term.rows}`;
    }
  }

  protected override onEscape(): void {
    // Escape belongs to the terminal.
  }

  protected override onBackdrop(): void {}

  protected override onCloseButton(): void {
    if (!this.started || this.exited) {
      this.close();
      return;
    }
    void this.askChild(
      () =>
        ConfirmModal.confirm("End shell session?", "The running shell and its processes will be terminated.", {
          ok: "End session",
          danger: true,
        }),
      false,
    ).then((ok) => {
      if (ok) this.close();
    });
  }

  protected override onClose(): void {
    this.observer.disconnect();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.term.dispose();
  }
}
