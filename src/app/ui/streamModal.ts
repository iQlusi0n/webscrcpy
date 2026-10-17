import type { DeviceStreamSettings } from "@common/api.ts";
import type { DeviceDescriptor } from "@common/protocol.ts";
import { api, errorMessage } from "../api.ts";
import { startStream } from "../stream/index.ts";
import type { StreamHandle } from "../stream/types.ts";
import { deviceDisplayName } from "./deviceCard.ts";
import { resolveMaxSize } from "./fitToScreen.ts";
import { Modal } from "./modal.ts";

/** Hosts a stream view. Escape and backdrop are blocked while connected; × always stops. */
export class StreamModal extends Modal {
  private handle: StreamHandle | null = null;
  private readonly container = document.createElement("div");
  private readonly error = document.createElement("div");

  constructor(
    private readonly device: DeviceDescriptor,
    private readonly settings?: DeviceStreamSettings,
  ) {
    super({ title: deviceDisplayName(device), className: "modal-auto", dismissible: false });
    this.body.className = "modal-body stream-modal-body";
    this.container.className = "stream-container";
    this.error.className = "stream-error hidden";
    this.body.append(this.container, this.error);
    this.footer.remove();
  }

  protected override onOpen(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    let settings = this.settings;
    if (!settings) {
      try {
        settings = await api.settings.device(this.device.serial);
      } catch (err) {
        this.fail(new Error(`could not load stream settings: ${errorMessage(err)}`));
        return;
      }
    }
    if (this.closeStarted) return;
    const opts = {
      serial: this.device.serial,
      settings: resolveMaxSize(settings, {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      }),
      container: this.container,
      onConnect: () => {
        this.error.classList.add("hidden");
      },
      onDisconnect: () => {
        this.close();
      },
      onError: (err: Error) => {
        this.fail(err);
      },
      ...(this.device.kind ? { deviceKind: this.device.kind } : {}),
    };
    const handle = startStream(opts);
    this.handle = handle;
    // The engine may end synchronously (e.g. invalid serial) before the handle was assigned.
    if (this.closeStarted) handle.stop();
  }

  private fail(err: Error): void {
    this.error.textContent = err.message;
    this.error.classList.remove("hidden");
    this.closeAfter(4000);
  }

  protected override onEscape(): void {
    if (!this.handle?.isConnected) this.close();
  }

  protected override onBackdrop(): void {
    if (!this.handle?.isConnected) this.close();
  }

  protected override onCloseButton(): void {
    this.close();
  }

  protected override canNativeClose(): boolean {
    return !this.handle?.isConnected;
  }

  /** stop() is idempotent, so this is safe after the engine already ended the stream. */
  protected override onClose(): void {
    this.handle?.stop();
  }
}
