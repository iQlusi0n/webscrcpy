import type { DeviceDescriptor, DeviceKind, DeviceState } from "@common/protocol.ts";
import { api, errorMessage } from "../api.ts";
import { ConfigureModal } from "./configureModal.ts";
import { streamBlockedReason } from "./context.ts";
import { FilesModal } from "./filesModal.ts";
import { type IconName, icon } from "./icons.ts";
import { button, iconButton } from "./modal.ts";
import { ShellModal } from "./shellModal.ts";
import { StreamModal } from "./streamModal.ts";

const KIND_ICON: Record<DeviceKind, IconName> = { phone: "phone", tablet: "tablet", tv: "tv" };

const STATE_TEXT: Record<DeviceState, string> = {
  device: "",
  offline: "offline",
  unauthorized: "unauthorized — accept the USB debugging prompt on the device",
  authorizing: "authorizing…",
  connecting: "connecting…",
};

export function deviceModelText(d: DeviceDescriptor): string {
  const model = d.model ?? "";
  const manufacturer = d.manufacturer ?? "";
  if (!manufacturer) return model;
  if (!model) return manufacturer;
  if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) return model;
  return `${manufacturer} ${model}`;
}

export function deviceDisplayName(d: DeviceDescriptor): string {
  return d.label || deviceModelText(d) || d.serial;
}

export class DeviceCard {
  readonly el: HTMLDivElement;
  private device: DeviceDescriptor;

  private readonly nameRow = document.createElement("div");
  private readonly nameEl = document.createElement("span");
  private readonly kindEl = document.createElement("span");
  private readonly editBtn: HTMLButtonElement;
  private readonly modelDd = document.createElement("dd");
  private readonly serialDd = document.createElement("dd");
  private readonly androidDd = document.createElement("dd");
  private readonly sdkDd = document.createElement("dd");
  private readonly stateText = document.createElement("div");
  private readonly connectBtn: HTMLButtonElement;
  private readonly configureBtn: HTMLButtonElement;
  private readonly shellBtn: HTMLButtonElement;
  private readonly filesBtn: HTMLButtonElement;
  private readonly powerBtn: HTMLButtonElement;
  private readonly disconnectBtn: HTMLButtonElement;
  private editing = false;
  private powerBusy = false;

  constructor(device: DeviceDescriptor) {
    this.device = device;
    this.el = document.createElement("div");
    this.el.className = "device-card";

    this.nameRow.className = "name-row";
    this.nameEl.className = "name";
    this.kindEl.className = "kind-badge";
    this.editBtn = iconButton("pencil", "Edit label", () => this.startEdit());
    this.nameRow.append(this.kindEl, this.nameEl, this.editBtn);

    const meta = document.createElement("dl");
    meta.className = "meta";
    this.serialDd.className = "mono";
    for (const [label, dd] of [
      ["model", this.modelDd],
      ["serial", this.serialDd],
      ["android", this.androidDd],
      ["sdk", this.sdkDd],
    ] as const) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      meta.append(dt, dd);
    }
    this.stateText.className = "state-text";

    const actions = document.createElement("div");
    actions.className = "actions";
    this.connectBtn = button("Connect", "primary", () => this.openStream());
    this.configureBtn = button("Configure", "default", () => new ConfigureModal(this.device).open());
    this.shellBtn = button("Shell", "default", () => new ShellModal(this.device).open());
    this.filesBtn = button("Files", "default", () => new FilesModal(this.device).open());
    this.powerBtn = button("checking…", "default", () => void this.togglePower());
    this.disconnectBtn = button("Disconnect", "danger", () => void this.disconnect());
    actions.append(this.connectBtn, this.configureBtn, this.shellBtn, this.filesBtn, this.powerBtn, this.disconnectBtn);

    this.el.append(this.nameRow, meta, this.stateText, actions);
    this.update(device);
  }

  get serial(): string {
    return this.device.serial;
  }

  update(device: DeviceDescriptor): void {
    this.device = device;
    this.el.dataset.state = device.state;
    if (!this.editing) this.nameEl.textContent = deviceDisplayName(device);
    this.nameEl.title = device.label ? `${device.label} (${deviceModelText(device) || device.serial})` : "";
    this.kindEl.textContent = "";
    if (device.kind) {
      this.kindEl.appendChild(icon(KIND_ICON[device.kind]));
      this.kindEl.title = device.kind;
    }
    this.modelDd.textContent = deviceModelText(device) || "—";
    this.serialDd.textContent = device.serial;
    this.androidDd.textContent = device.androidVersion ?? "—";
    this.sdkDd.textContent = device.sdk === undefined ? "—" : String(device.sdk);
    this.stateText.textContent = STATE_TEXT[device.state];

    const ready = device.state === "device";
    const blocked = streamBlockedReason();
    this.connectBtn.disabled = !ready || blocked !== null;
    this.connectBtn.title = blocked ?? "";
    this.configureBtn.disabled = !ready;
    this.shellBtn.disabled = !ready;
    this.filesBtn.disabled = !ready;
    this.disconnectBtn.classList.toggle("hidden", !device.isNetwork);
    if (!this.powerBusy) this.renderPower(ready ? device.screen : "unknown");
  }

  private renderPower(screen: DeviceDescriptor["screen"]): void {
    this.powerBtn.disabled = screen === "unknown" || this.device.state !== "device";
    this.powerBtn.textContent = screen === "awake" ? "turn off" : screen === "asleep" ? "turn on" : "checking…";
  }

  private async togglePower(): Promise<void> {
    if (this.powerBusy) return;
    const action = this.device.screen === "awake" ? "sleep" : "wake";
    this.powerBusy = true;
    this.powerBtn.disabled = true;
    try {
      const res = await api.devices.sleepWake({ serial: this.device.serial, action });
      this.device = { ...this.device, screen: res.awake ? "awake" : "asleep" };
    } catch (err) {
      this.stateText.textContent = errorMessage(err);
    } finally {
      this.powerBusy = false;
      this.renderPower(this.device.screen);
    }
  }

  private async disconnect(): Promise<void> {
    this.disconnectBtn.disabled = true;
    try {
      const res = await api.devices.disconnect({ address: this.device.serial });
      if (!res.ok) this.stateText.textContent = res.message ?? "disconnect failed";
    } catch (err) {
      this.stateText.textContent = errorMessage(err);
    } finally {
      this.disconnectBtn.disabled = false;
    }
  }

  private openStream(): void {
    if (streamBlockedReason()) return;
    new StreamModal(this.device).open();
  }

  private startEdit(): void {
    if (this.editing) return;
    this.editing = true;
    const input = document.createElement("input");
    input.className = "input";
    input.value = this.device.label ?? "";
    input.placeholder = deviceModelText(this.device) || this.device.serial;
    input.maxLength = 64;
    const finish = (save: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      input.replaceWith(this.nameEl);
      this.editBtn.classList.remove("hidden");
      if (save) void this.saveLabel(input.value.trim());
      else this.nameEl.textContent = deviceDisplayName(this.device);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(false));
    this.nameEl.replaceWith(input);
    this.editBtn.classList.add("hidden");
    input.focus();
    input.select();
  }

  private async saveLabel(label: string): Promise<void> {
    const previous = this.device.label;
    const next = label || undefined;
    if (next === previous) {
      this.nameEl.textContent = deviceDisplayName(this.device);
      return;
    }
    // Optimistic: show the new name now; the device list echoes the server's view later.
    this.device = { ...this.device, label: next };
    this.nameEl.textContent = deviceDisplayName(this.device);
    try {
      await api.devices.setLabel({ serial: this.device.serial, label });
    } catch (err) {
      this.device = { ...this.device, label: previous };
      this.nameEl.textContent = deviceDisplayName(this.device);
      this.stateText.textContent = `label not saved: ${errorMessage(err)}`;
    }
  }
}
