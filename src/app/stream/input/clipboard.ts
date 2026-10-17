/**
 * Clipboard both ways. Device → browser via CLIPBOARD device messages (navigator.clipboard, with
 * an in-container "click to copy" prompt when the write is rejected outside a user gesture).
 * Browser → device via SET_CLIPBOARD with an increasing sequence tracked against ACK_CLIPBOARD.
 */
import { CopyKey } from "@common/scrcpy.ts";
import { getClipboard, setClipboard } from "../control.ts";
import type { SendControl } from "./text.ts";

export const CLIPBOARD_PROMPT_TEXT = "Device clipboard ready — click to copy";
const PROMPT_HIDE_MS = 30_000;

export class ClipboardSync {
  private sequence = 0n;
  private pendingAck: bigint | null = null;
  private pendingText = "";
  private generation = 0;
  private hideTimer: number | undefined;
  private readonly prompt: HTMLButtonElement;

  constructor(
    private readonly send: SendControl,
    private readonly container: HTMLElement,
  ) {
    this.prompt = document.createElement("button");
    this.prompt.type = "button";
    this.prompt.className = "stream-clipboard-prompt";
    this.prompt.textContent = CLIPBOARD_PROMPT_TEXT;
    this.prompt.hidden = true;
    this.prompt.addEventListener("click", () => this.copyViaGesture());
    this.container.appendChild(this.prompt);
  }

  /** Ask the device to copy the current selection; the result arrives via autosync. */
  requestFromDevice(): void {
    this.send(getClipboard(CopyKey.COPY));
  }

  /** Push the browser clipboard to the device. */
  async pushToDevice(): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      console.warn("[clipboard] readText rejected", err);
      return;
    }
    if (text.length === 0) return;
    this.sequence++;
    this.pendingAck = this.sequence;
    this.send(setClipboard(this.sequence, false, text));
  }

  /** Called for each device message of type clipboard/ack-clipboard. */
  onDeviceClipboard(text: string): void {
    const generation = ++this.generation;
    this.pendingText = text;
    navigator.clipboard.writeText(text).then(
      () => {
        if (generation === this.generation) this.hidePrompt();
      },
      () => {
        if (generation === this.generation) this.showPrompt();
      },
    );
  }

  onAck(sequence: bigint): boolean {
    if (this.pendingAck !== sequence) return false;
    this.pendingAck = null;
    return true;
  }

  get awaitingAck(): boolean {
    return this.pendingAck !== null;
  }

  destroy(): void {
    clearTimeout(this.hideTimer);
    this.prompt.remove();
  }

  private showPrompt(): void {
    this.prompt.hidden = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hidePrompt(), PROMPT_HIDE_MS);
  }

  private hidePrompt(): void {
    this.prompt.hidden = true;
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  /** Inside a click handler: try the async API again, then the execCommand fallback. */
  private copyViaGesture(): void {
    const text = this.pendingText;
    navigator.clipboard.writeText(text).then(
      () => this.hidePrompt(),
      () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        this.container.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          ta.remove();
        }
        this.hidePrompt();
      },
    );
  }
}
