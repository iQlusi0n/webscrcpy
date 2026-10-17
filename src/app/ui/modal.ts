/**
 * Base class over a native <dialog> (showModal → focus trap, inert page, Escape via `cancel`).
 * Supports parent/child stacking: children close with their parent, and `askChild` returns a
 * fallback when the parent closes before the child answers.
 */
import { type IconName, icon } from "./icons.ts";

export interface ModalOptions {
  title: string;
  /** Escape / backdrop / × close the dialog (default true) */
  dismissible?: boolean;
  /** extra class on the <dialog>, e.g. "modal-wide" | "modal-auto" */
  className?: string;
  /** buttons rendered between the title and the × */
  headerButtons?: HTMLElement[];
  /** hide the × (default false) */
  noCloseButton?: boolean;
}

export type ButtonKind = "default" | "primary" | "danger";

const BUTTON_CLASS: Record<ButtonKind, string> = {
  default: "btn",
  primary: "btn btn-primary",
  danger: "btn btn-danger",
};

export function button(text: string, kind: ButtonKind, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = BUTTON_CLASS[kind];
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

export function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-icon";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.appendChild(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

/** The modal whose `askChild`/`openChild` is currently running; new modals attach to it. */
let openingParent: Modal | null = null;

export class Modal {
  readonly dialog: HTMLDialogElement;
  readonly titleEl: HTMLHeadingElement;
  readonly body: HTMLDivElement;
  readonly footer: HTMLDivElement;
  protected readonly dismissible: boolean;

  private parent: Modal | null = null;
  private readonly children = new Set<Modal>();
  private opened = false;
  private closed = false;
  /** true from the moment close() is entered, even before the children are torn down */
  protected closeStarted = false;
  private closeTimer: number | undefined;
  private readonly onNativeClose = () => {
    // The platform closed us (e.g. Chromium's close watcher); run the normal teardown.
    if (!this.closeStarted) this.close();
  };

  constructor(opts: ModalOptions) {
    this.dismissible = opts.dismissible !== false;
    this.dialog = document.createElement("dialog");
    this.dialog.className = `modal${opts.className ? ` ${opts.className}` : ""}`;

    const header = document.createElement("div");
    header.className = "modal-header";
    this.titleEl = document.createElement("h2");
    this.titleEl.textContent = opts.title;
    header.appendChild(this.titleEl);
    for (const b of opts.headerButtons ?? []) header.appendChild(b);
    if (!opts.noCloseButton) header.appendChild(iconButton("close", "Close", () => this.onCloseButton()));

    this.body = document.createElement("div");
    this.body.className = "modal-body";
    this.footer = document.createElement("div");
    this.footer.className = "modal-footer";

    this.dialog.append(header, this.body, this.footer);
    this.dialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      this.onEscape();
    });
    this.dialog.addEventListener("click", (ev) => {
      if (ev.target === this.dialog) this.onBackdrop();
    });
    this.dialog.addEventListener("close", this.onNativeClose);
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  open(): this {
    if (this.opened) return this;
    this.opened = true;
    if (openingParent && openingParent !== this) openingParent.adopt(this);
    document.body.appendChild(this.dialog);
    this.dialog.showModal();
    this.onOpen();
    return this;
  }

  close(): void {
    if (this.closed || this.closeStarted) return;
    this.closeStarted = true;
    clearTimeout(this.closeTimer);
    for (const child of [...this.children]) child.close();
    this.children.clear();
    this.parent?.children.delete(this);
    this.dialog.removeEventListener("close", this.onNativeClose);
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.closed = true;
    this.onClose();
  }

  /** Schedules close(); a later close() cancels the timer. */
  protected closeAfter(ms: number): void {
    if (this.closed) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => this.close(), ms);
  }

  protected adopt(child: Modal): void {
    child.parent = this;
    this.children.add(child);
  }

  /** Runs `open` with this modal as the parent of anything it opens synchronously. */
  protected openChild<T>(open: () => T): T {
    const previous = openingParent;
    openingParent = this;
    try {
      return open();
    } finally {
      openingParent = previous;
    }
  }

  /**
   * Like openChild for a question: if this modal closes before the child answers, the child is
   * closed with it and the result is `unanswered` rather than whatever the child resolved to.
   */
  protected askChild<T>(ask: () => Promise<T>, unanswered: T): Promise<T> {
    return this.openChild(ask).then((answer) => (this.closeStarted ? unanswered : answer));
  }

  protected onOpen(): void {}
  protected onClose(): void {}

  protected onEscape(): void {
    if (this.dismissible) this.close();
  }

  protected onBackdrop(): void {
    if (this.dismissible) this.close();
  }

  /** The × button; defaults to the same rule as Escape. */
  protected onCloseButton(): void {
    this.onEscape();
  }
}
