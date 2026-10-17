import type { DeviceDescriptor, FileEntry, FilesPushEnd, FilesRequest, FilesResponse } from "@common/protocol.ts";
import { FILES_BINARY_PREFIX, FILES_CHUNK_SIZE } from "@common/protocol.ts";
import { api, errorMessage, wsUrl } from "../api.ts";
import { ConfirmModal } from "./confirm.ts";
import { deviceDisplayName } from "./deviceCard.ts";
import { type IconName, icon } from "./icons.ts";
import { button, iconButton, Modal } from "./modal.ts";

const START_PATH = "/sdcard";
const FALLBACK_PATH = "/data/local/tmp";
/** Pause sending push chunks while this many bytes sit in the socket buffer. */
const PUSH_HIGH_WATER = 1 << 20;

const EXT_ICON: Record<string, IconName> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  heic: "image",
  svg: "image",
  mp4: "video",
  mkv: "video",
  webm: "video",
  mov: "video",
  avi: "video",
  "3gp": "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  opus: "audio",
  wav: "audio",
  txt: "text",
  log: "text",
  json: "text",
  xml: "text",
  md: "text",
  csv: "text",
  html: "text",
  js: "text",
  sh: "text",
  prop: "text",
};

function iconFor(entry: FileEntry): IconName {
  if (entry.isDir) return "folder";
  const dot = entry.name.lastIndexOf(".");
  if (dot < 0) return "file";
  return EXT_ICON[entry.name.slice(dot + 1).toLowerCase()] ?? "file";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

type SortKey = "name" | "size" | "mtime";

type Pending = {
  onText(msg: FilesResponse): void;
  onBinary?(chunk: Uint8Array): void;
};

/** Request/response multiplexer over /ws/files. */
class FilesClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;

  constructor(serial: string, onClosed: (reason: string) => void) {
    const ws = new WebSocket(wsUrl("/ws/files", { serial }));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("close", (ev) => {
        reject(new Error(ev.reason || `files channel closed (${ev.code})`));
        this.ws = null;
        for (const p of this.pending.values()) p.onText({ id: 0, type: "error", message: "connection closed" });
        this.pending.clear();
        onClosed(ev.reason || (ev.code === 1000 ? "" : `connection closed (${ev.code})`));
      });
    });
    this.ready.catch(() => undefined);
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
  }

  get inFlight(): number {
    return this.pending.size;
  }

  close(): void {
    this.ws?.close();
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < FILES_BINARY_PREFIX) return;
      const id = new DataView(data).getUint32(0, true);
      this.pending.get(id)?.onBinary?.(new Uint8Array(data, FILES_BINARY_PREFIX));
      return;
    }
    if (typeof data !== "string") return;
    let msg: FilesResponse;
    try {
      msg = JSON.parse(data) as FilesResponse;
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "done" || msg.type === "error" || msg.type === "list" || msg.type === "stat")
      this.pending.delete(msg.id);
    p.onText(msg);
  }

  private async send(req: FilesRequest | FilesPushEnd): Promise<void> {
    await this.ready;
    if (!this.ws) throw new Error("files channel closed");
    this.ws.send(JSON.stringify(req));
  }

  private async sendBinary(id: number, chunk: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws) throw new Error("files channel closed");
    while (ws.bufferedAmount > PUSH_HIGH_WATER && ws.readyState === WebSocket.OPEN) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (ws.readyState !== WebSocket.OPEN) throw new Error("files channel closed");
    const frame = new Uint8Array(FILES_BINARY_PREFIX + chunk.byteLength);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(chunk, FILES_BINARY_PREFIX);
    ws.send(frame);
  }

  list(path: string): Promise<FileEntry[]> {
    const id = this.nextId++;
    return new Promise<FileEntry[]>((resolve, reject) => {
      this.pending.set(id, {
        onText: (msg) => {
          if (msg.type === "list") resolve(msg.entries);
          else if (msg.type === "error") reject(new Error(msg.message));
        },
      });
      this.send({ id, op: "list", path }).catch(reject);
    });
  }

  stat(path: string): Promise<FileEntry> {
    const id = this.nextId++;
    return new Promise<FileEntry>((resolve, reject) => {
      this.pending.set(id, {
        onText: (msg) => {
          if (msg.type === "stat") resolve(msg.entry);
          else if (msg.type === "error") reject(new Error(msg.message));
        },
      });
      this.send({ id, op: "stat", path }).catch(reject);
    });
  }

  pull(path: string, onProgress: (bytes: number) => void): Promise<Blob> {
    const id = this.nextId++;
    const chunks: Uint8Array[] = [];
    let received = 0;
    return new Promise<Blob>((resolve, reject) => {
      this.pending.set(id, {
        onBinary: (chunk) => {
          chunks.push(chunk);
          received += chunk.byteLength;
          onProgress(received);
        },
        onText: (msg) => {
          if (msg.type === "done") resolve(new Blob(chunks as BlobPart[]));
          else if (msg.type === "error") reject(new Error(msg.message));
          else if (msg.type === "progress") onProgress(msg.bytes);
        },
      });
      this.send({ id, op: "pull", path }).catch(reject);
    });
  }

  async push(path: string, file: File, onProgress: (bytes: number) => void): Promise<void> {
    const id = this.nextId++;
    let ready!: () => void;
    let done!: () => void;
    let fail!: (err: Error) => void;
    const readyP = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const doneP = new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = (err) => {
        reject(err);
      };
    });
    const failBoth = (err: Error) => {
      fail(err);
      readyP.catch(() => undefined);
      doneP.catch(() => undefined);
    };
    this.pending.set(id, {
      onText: (msg) => {
        if (msg.type === "ready") ready();
        else if (msg.type === "done") done();
        else if (msg.type === "progress") onProgress(msg.bytes);
        else if (msg.type === "error") failBoth(new Error(msg.message));
      },
    });
    await this.send({ id, op: "push", path, size: file.size });
    await Promise.race([readyP, doneP]);
    const reader = file.stream().getReader();
    let sent = 0;
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        for (let off = 0; off < value.byteLength; off += FILES_CHUNK_SIZE) {
          const chunk = value.subarray(off, Math.min(off + FILES_CHUNK_SIZE, value.byteLength));
          await this.sendBinary(id, chunk);
          sent += chunk.byteLength;
          onProgress(sent);
        }
      }
      await this.send({ id, op: "push-end" });
    } catch (err) {
      this.pending.delete(id);
      this.send({ id, op: "cancel" }).catch(() => undefined);
      throw err;
    }
    await doneP;
  }
}

interface TransferRow {
  tr: HTMLTableRowElement;
  bar: HTMLDivElement;
  status: HTMLTableCellElement;
}

export class FilesModal extends Modal {
  private readonly client: FilesClient;
  private path = START_PATH;
  private entries: FileEntry[] = [];
  private filterText = "";
  private sortKey: SortKey = "name";
  private sortAsc = true;
  private readonly selected = new Set<string>();
  private transfers = 0;

  private readonly breadcrumbs = document.createElement("div");
  private readonly filter = document.createElement("input");
  private readonly list = document.createElement("div");
  private readonly tbody = document.createElement("tbody");
  private readonly headerCheck = document.createElement("input");
  private readonly headers: Record<SortKey, HTMLTableCellElement> = {
    name: document.createElement("th"),
    size: document.createElement("th"),
    mtime: document.createElement("th"),
  };
  private readonly status = document.createElement("div");
  private readonly deleteBtn: HTMLButtonElement;
  private readonly downloadBtn: HTMLButtonElement;
  private readonly uploadBtn: HTMLButtonElement;
  private readonly fileInput = document.createElement("input");
  private readonly dropOverlay = document.createElement("div");
  private readonly message = document.createElement("div");
  private dragDepth = 0;

  constructor(private readonly device: DeviceDescriptor) {
    super({
      title: `Files — ${deviceDisplayName(device)}`,
      className: "modal-wide",
      headerButtons: [iconButton("refresh", "Reload", () => void this.load(this.path))],
    });
    this.client = new FilesClient(device.serial, (reason) => {
      if (!this.closeStarted && reason) this.showMessage(reason, true);
    });
    this.body.className = "modal-body modal-body-flush files-body";

    const toolbar = document.createElement("div");
    toolbar.className = "files-toolbar";
    this.breadcrumbs.className = "breadcrumbs";
    this.filter.className = "input";
    this.filter.type = "search";
    this.filter.placeholder = "filter";
    this.filter.addEventListener("input", () => {
      this.filterText = this.filter.value.trim().toLowerCase();
      this.render();
    });
    toolbar.append(this.breadcrumbs, this.filter);

    this.list.className = "files-list";
    const table = document.createElement("table");
    table.className = "files-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const thCheck = document.createElement("th");
    thCheck.className = "col-check";
    this.headerCheck.type = "checkbox";
    this.headerCheck.addEventListener("change", () => this.toggleAll(this.headerCheck.checked));
    thCheck.appendChild(this.headerCheck);
    this.headers.name.className = "col-name";
    this.headers.size.className = "col-size";
    this.headers.mtime.className = "col-date";
    for (const key of ["name", "size", "mtime"] as const) {
      this.headers[key].addEventListener("click", () => this.sortBy(key));
    }
    const thActions = document.createElement("th");
    thActions.className = "col-actions";
    hr.append(thCheck, this.headers.name, this.headers.size, this.headers.mtime, thActions);
    thead.appendChild(hr);
    table.append(thead, this.tbody);
    this.list.appendChild(table);

    this.message.className = "note hidden";
    this.message.style.margin = "8px 12px";

    const footer = document.createElement("div");
    footer.className = "files-footer";
    this.status.className = "files-status";
    this.deleteBtn = button("Delete", "danger", () => void this.deleteSelected());
    this.downloadBtn = button("Download", "default", () => void this.downloadSelected());
    this.uploadBtn = button("Upload", "primary", () => this.fileInput.click());
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.className = "hidden";
    this.fileInput.addEventListener("change", () => {
      const files = this.fileInput.files ? [...this.fileInput.files] : [];
      this.fileInput.value = "";
      void this.uploadFiles(files);
    });
    footer.append(this.status, this.deleteBtn, this.downloadBtn, this.uploadBtn, this.fileInput);

    this.dropOverlay.className = "drop-overlay hidden";
    this.dropOverlay.textContent = "drop files to upload";
    this.body.append(toolbar, this.list, this.message, footer, this.dropOverlay);
    this.footer.remove();
    this.setupDragDrop();
    this.renderSortIndicators();
    this.updateFooter();
  }

  protected override onOpen(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      await this.client.stat(START_PATH);
      await this.load(START_PATH);
    } catch {
      await this.load(FALLBACK_PATH);
    }
  }

  private showMessage(text: string, isError: boolean): void {
    this.message.textContent = text;
    this.message.className = isError ? "note note-error" : "note";
  }

  private hideMessage(): void {
    this.message.className = "note hidden";
  }

  private async load(path: string): Promise<void> {
    this.status.textContent = "loading…";
    this.hideMessage();
    try {
      const entries = await this.client.list(path);
      this.path = path;
      this.entries = entries.filter((e) => e.name !== "." && e.name !== "..");
      this.selected.clear();
      this.renderBreadcrumbs();
      this.render();
    } catch (err) {
      this.showMessage(`cannot list ${path}: ${errorMessage(err)}`, true);
      this.updateFooter();
    }
  }

  private renderBreadcrumbs(): void {
    this.breadcrumbs.textContent = "";
    const parts = this.path.split("/").filter(Boolean);
    const root = document.createElement("button");
    root.textContent = "/";
    root.addEventListener("click", () => void this.load("/"));
    this.breadcrumbs.appendChild(root);
    let acc = "";
    parts.forEach((part, i) => {
      acc += `/${part}`;
      const target = acc;
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "/";
        this.breadcrumbs.appendChild(sep);
      }
      const b = document.createElement("button");
      b.textContent = part;
      b.addEventListener("click", () => void this.load(target));
      this.breadcrumbs.appendChild(b);
    });
  }

  private sortBy(key: SortKey): void {
    if (this.sortKey === key) this.sortAsc = !this.sortAsc;
    else {
      this.sortKey = key;
      this.sortAsc = key === "name";
    }
    this.renderSortIndicators();
    this.render();
  }

  private renderSortIndicators(): void {
    const labels: Record<SortKey, string> = { name: "name", size: "size", mtime: "modified" };
    for (const key of ["name", "size", "mtime"] as const) {
      const arrow = this.sortKey === key ? (this.sortAsc ? " ▲" : " ▼") : "";
      this.headers[key].textContent = labels[key] + arrow;
    }
  }

  private visibleEntries(): FileEntry[] {
    const list = this.filterText
      ? this.entries.filter((e) => e.name.toLowerCase().includes(this.filterText))
      : [...this.entries];
    const dir = this.sortAsc ? 1 : -1;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (this.sortKey === "size") cmp = a.size - b.size;
      else if (this.sortKey === "mtime") cmp = a.mtime - b.mtime;
      if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return cmp * dir;
    });
    return list;
  }

  private render(): void {
    this.tbody.textContent = "";
    for (const entry of this.visibleEntries()) this.tbody.appendChild(this.renderRow(entry));
    this.updateFooter();
  }

  private renderRow(entry: FileEntry): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = entry.isDir ? "dir" : "file";
    tr.dataset.name = entry.name;

    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.selected.has(entry.name);
    cb.addEventListener("change", () => {
      if (cb.checked) this.selected.add(entry.name);
      else this.selected.delete(entry.name);
      this.updateFooter();
    });
    tdCheck.appendChild(cb);

    const tdName = document.createElement("td");
    tdName.className = "col-name";
    tdName.append(icon(iconFor(entry)), document.createTextNode(entry.name + (entry.isLink ? " →" : "")));
    tdName.title = entry.name;
    if (entry.isDir) tdName.addEventListener("click", () => void this.load(joinPath(this.path, entry.name)));

    const tdSize = document.createElement("td");
    tdSize.className = "col-size";
    tdSize.textContent = entry.isDir ? "" : formatSize(entry.size);
    const tdDate = document.createElement("td");
    tdDate.className = "col-date";
    tdDate.textContent = formatDate(entry.mtime);

    const tdActions = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (!entry.isDir) actions.appendChild(iconButton("download", "Download", () => void this.download(entry)));
    actions.appendChild(iconButton("trash", "Delete", () => void this.deletePaths([entry.name])));
    tdActions.appendChild(actions);

    tr.append(tdCheck, tdName, tdSize, tdDate, tdActions);
    return tr;
  }

  private toggleAll(checked: boolean): void {
    this.selected.clear();
    if (checked) for (const e of this.visibleEntries()) this.selected.add(e.name);
    for (const cb of this.tbody.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) cb.checked = checked;
    this.updateFooter();
  }

  private updateFooter(): void {
    const visible = this.visibleEntries().length;
    const n = this.selected.size;
    this.headerCheck.checked = n > 0 && n === visible;
    this.headerCheck.indeterminate = n > 0 && n < visible;
    const transfers = this.transfers
      ? `, ${this.transfers} transfer${this.transfers === 1 ? "" : "s"} in progress`
      : "";
    this.status.textContent = `${n} selected / ${visible} item${visible === 1 ? "" : "s"}${transfers}`;
    this.deleteBtn.disabled = n === 0;
    const files = [...this.selected].filter((name) => this.entries.some((e) => e.name === name && !e.isDir));
    this.downloadBtn.disabled = files.length === 0;
  }

  // ---------------------------------------------------------------- transfers

  private addTransferRow(label: string): TransferRow {
    const tr = document.createElement("tr");
    tr.className = "transfer";
    const td = document.createElement("td");
    const tdName = document.createElement("td");
    tdName.className = "col-name";
    tdName.textContent = label;
    const bar = document.createElement("div");
    const progress = document.createElement("div");
    progress.className = "progress";
    progress.appendChild(bar);
    tdName.appendChild(progress);
    const status = document.createElement("td");
    status.className = "col-size";
    status.colSpan = 3;
    tr.append(td, tdName, status);
    this.tbody.prepend(tr);
    this.transfers++;
    this.updateFooter();
    return { tr, bar, status };
  }

  private endTransfer(row: TransferRow, text: string | null): void {
    this.transfers--;
    if (text === null) row.tr.remove();
    else {
      row.status.textContent = text;
      row.status.classList.add("error-text");
      row.bar.style.width = "0";
    }
    this.updateFooter();
  }

  private async download(entry: FileEntry): Promise<void> {
    const row = this.addTransferRow(`↓ ${entry.name}`);
    try {
      const blob = await this.client.pull(joinPath(this.path, entry.name), (bytes) => {
        row.bar.style.width = entry.size ? `${Math.min(100, (bytes / entry.size) * 100)}%` : "50%";
        row.status.textContent = `${formatSize(bytes)}${entry.size ? ` / ${formatSize(entry.size)}` : ""}`;
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.endTransfer(row, null);
    } catch (err) {
      this.endTransfer(row, `download failed: ${errorMessage(err)}`);
    }
  }

  private async downloadSelected(): Promise<void> {
    const files = this.entries.filter((e) => this.selected.has(e.name) && !e.isDir);
    for (const f of files) await this.download(f);
  }

  private async uploadFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const dir = this.path;
    for (const file of files) {
      const row = this.addTransferRow(`↑ ${file.name}`);
      try {
        await this.client.push(joinPath(dir, file.name), file, (bytes) => {
          row.bar.style.width = file.size ? `${Math.min(100, (bytes / file.size) * 100)}%` : "100%";
          row.status.textContent = `${formatSize(bytes)} / ${formatSize(file.size)}`;
        });
        this.endTransfer(row, null);
      } catch (err) {
        this.endTransfer(row, `upload failed: ${errorMessage(err)}`);
      }
    }
    if (this.path === dir) await this.load(dir);
  }

  private async deleteSelected(): Promise<void> {
    await this.deletePaths([...this.selected]);
  }

  private async deletePaths(names: string[]): Promise<void> {
    if (names.length === 0) return;
    const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
    const ok = await this.askChild(
      () =>
        ConfirmModal.confirm(
          "Delete?",
          `Permanently delete ${what} from ${this.path}? Directories are removed recursively.`,
          { ok: "Delete", danger: true },
        ),
      false,
    );
    if (!ok) return;
    this.hideMessage();
    try {
      const res = await api.devices.deleteFiles({
        serial: this.device.serial,
        paths: names.map((n) => joinPath(this.path, n)),
      });
      if (!res.ok && res.errors?.length) {
        this.showMessage(
          `${res.errors.length} of ${names.length} not deleted: ${res.errors.map((e) => `${e.path} (${e.error})`).join("; ")}`,
          true,
        );
      }
    } catch (err) {
      this.showMessage(`delete failed: ${errorMessage(err)}`, true);
    }
    const message = this.message.className;
    await this.load(this.path);
    this.message.className = message; // keep the 207 detail visible after the reload
  }

  // ---------------------------------------------------------------- drag & drop

  private setupDragDrop(): void {
    const body = this.body;
    body.addEventListener("dragenter", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      this.dragDepth++;
      this.dropOverlay.classList.remove("hidden");
    });
    body.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    });
    body.addEventListener("dragleave", () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.dropOverlay.classList.add("hidden");
    });
    body.addEventListener("drop", (ev) => {
      ev.preventDefault();
      this.dragDepth = 0;
      this.dropOverlay.classList.add("hidden");
      const files = ev.dataTransfer ? [...ev.dataTransfer.files] : [];
      void this.uploadFiles(files);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  private requestClose(): void {
    if (this.transfers === 0) {
      this.close();
      return;
    }
    void this.askChild(
      () =>
        ConfirmModal.confirm(
          "Transfers in progress",
          `${this.transfers} transfer(s) are still running. Close and cancel them?`,
          { ok: "Close", danger: true },
        ),
      false,
    ).then((ok) => {
      if (ok) this.close();
    });
  }

  protected override onEscape(): void {
    this.requestClose();
  }

  protected override onBackdrop(): void {
    this.requestClose();
  }

  protected override onClose(): void {
    this.client.close();
  }
}
