/**
 * Drag-and-drop file push onto the stream view: files dropped on the video area are pushed to
 * `/sdcard/Download/<name>` over one `/ws/files` socket (protocol.ts FilesRequest/FilesResponse),
 * one at a time, with a small progress toast in the container.
 */
import type { FilesPushEnd, FilesRequest, FilesResponse } from "@common/protocol.ts";
import { FILES_BINARY_PREFIX, FILES_CHUNK_SIZE } from "@common/protocol.ts";

export const DROP_TARGET_DIR = "/sdcard/Download";
const TOAST_HIDE_MS = 4000;
/** pause sending chunks while this many bytes sit in the socket buffer */
const PUSH_HIGH_WATER = 1 << 20;

/** Target path for a dropped file: basename only, so a crafted name cannot escape the directory. */
export function dropTargetPath(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  let safe = "";
  for (const ch of base) if ((ch.codePointAt(0) ?? 0) >= 0x20) safe += ch;
  safe = safe.trim();
  return `${DROP_TARGET_DIR}/${safe.length === 0 || safe === "." || safe === ".." ? "dropped-file" : safe}`;
}

interface PendingPush {
  onText(msg: FilesResponse): void;
}

export class DropPush {
  private readonly toast: HTMLElement;
  private toastTimer: number | undefined;
  private destroyed = false;
  private queue: Promise<void> = Promise.resolve();
  private ws: WebSocket | null = null;
  private opened: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingPush>();

  constructor(
    private readonly serial: string,
    private readonly target: HTMLElement,
  ) {
    this.toast = document.createElement("div");
    this.toast.className = "stream-drop-toast";
    this.toast.hidden = true;
    target.appendChild(this.toast);
    target.addEventListener("dragover", this.onDragOver);
    target.addEventListener("dragleave", this.onDragLeave);
    target.addEventListener("drop", this.onDrop);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.target.removeEventListener("dragover", this.onDragOver);
    this.target.removeEventListener("dragleave", this.onDragLeave);
    this.target.removeEventListener("drop", this.onDrop);
    this.target.classList.remove("stream-drop-active");
    clearTimeout(this.toastTimer);
    this.toast.remove();
    this.ws?.close();
    this.ws = null;
  }

  // ---------------------------------------------------------------- drag events

  private readonly onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    this.target.classList.add("stream-drop-active");
  };

  private readonly onDragLeave = (): void => {
    this.target.classList.remove("stream-drop-active");
  };

  private readonly onDrop = (e: DragEvent): void => {
    this.target.classList.remove("stream-drop-active");
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const file of Array.from(files)) {
      this.queue = this.queue.then(() => this.pushOne(file));
    }
  };

  // ---------------------------------------------------------------- push

  private async pushOne(file: File): Promise<void> {
    if (this.destroyed) return;
    const path = dropTargetPath(file.name);
    this.showToast(`Pushing ${file.name}… 0%`, false);
    try {
      await this.push(path, file, (bytes) => {
        const pct = file.size === 0 ? 100 : Math.min(100, Math.floor((bytes / file.size) * 100));
        this.showToast(`Pushing ${file.name}… ${pct}%`, false);
      });
      this.showToast(`Pushed ${file.name} to ${DROP_TARGET_DIR}`, true);
    } catch (err) {
      this.showToast(`Push of ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  /** The shared /ws/files socket, opened on first use and reopened after a close. */
  private socket(): Promise<WebSocket> {
    if (this.opened) return this.opened;
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    this.opened = promise;
    promise.catch(() => undefined);
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/ws/files?serial=${encodeURIComponent(this.serial)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev: CloseEvent) => {
      const message = ev.reason || `files channel closed (${ev.code})`;
      reject(new Error(message));
      if (this.ws === ws) {
        this.ws = null;
        this.opened = null;
      }
      for (const p of this.pending.values()) p.onText({ id: 0, type: "error", message });
      this.pending.clear();
    });
    return promise;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: FilesResponse;
    try {
      msg = JSON.parse(data) as FilesResponse;
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "done" || msg.type === "error") this.pending.delete(msg.id);
    p.onText(msg);
  }

  private async push(path: string, file: File, onProgress: (bytes: number) => void): Promise<void> {
    const ws = await this.socket();
    const id = this.nextId++;
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    ready.promise.catch(() => undefined);
    done.promise.catch(() => undefined);
    this.pending.set(id, {
      onText: (msg) => {
        if (msg.type === "ready") ready.resolve();
        else if (msg.type === "done") done.resolve();
        else if (msg.type === "progress") onProgress(msg.bytes);
        else if (msg.type === "error") {
          const err = new Error(msg.message);
          ready.reject(err);
          done.reject(err);
        }
      },
    });
    const sendText = (req: FilesRequest | FilesPushEnd): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
    };
    sendText({ id, op: "push", path, size: file.size });
    await Promise.race([ready.promise, done.promise]);
    const reader = file.stream().getReader();
    let sent = 0;
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        for (let off = 0; off < value.byteLength; off += FILES_CHUNK_SIZE) {
          const chunk = value.subarray(off, Math.min(off + FILES_CHUNK_SIZE, value.byteLength));
          while (ws.bufferedAmount > PUSH_HIGH_WATER && ws.readyState === WebSocket.OPEN) {
            await new Promise((r) => setTimeout(r, 20));
          }
          if (ws.readyState !== WebSocket.OPEN) throw new Error("files channel closed");
          const frame = new Uint8Array(FILES_BINARY_PREFIX + chunk.byteLength);
          new DataView(frame.buffer).setUint32(0, id, true);
          frame.set(chunk, FILES_BINARY_PREFIX);
          ws.send(frame);
          sent += chunk.byteLength;
          onProgress(sent);
        }
      }
      sendText({ id, op: "push-end" });
    } catch (err) {
      this.pending.delete(id);
      sendText({ id, op: "cancel" });
      throw err;
    }
    await done.promise;
  }

  // ---------------------------------------------------------------- toast

  private showToast(text: string, autoHide: boolean): void {
    if (this.destroyed) return;
    this.toast.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
    if (autoHide) {
      this.toastTimer = window.setTimeout(() => {
        this.toast.hidden = true;
      }, TOAST_HIDE_MS);
    }
  }
}
