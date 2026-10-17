import { Modal, button } from "./modal.ts";

export interface ConfirmOptions {
  ok?: string;
  cancel?: string;
  /** style the OK button as destructive */
  danger?: boolean;
}

export class ConfirmModal extends Modal {
  private answered = false;
  private readonly resolve: (answer: boolean) => void;

  private constructor(title: string, text: string, opts: ConfirmOptions, resolve: (answer: boolean) => void) {
    super({ title, className: "modal-auto" });
    this.resolve = resolve;
    const p = document.createElement("p");
    p.textContent = text;
    p.style.maxWidth = "480px";
    p.style.margin = "0";
    p.style.whiteSpace = "pre-line";
    this.body.appendChild(p);
    this.footer.append(
      document.createElement("span"),
      button(opts.cancel ?? "Cancel", "default", () => this.close()),
      button(opts.ok ?? "OK", opts.danger ? "danger" : "primary", () => this.answer(true)),
    );
    const spacer = this.footer.firstElementChild;
    if (spacer) spacer.className = "spacer";
  }

  /** Resolves true on OK, false on cancel / Escape / backdrop / × / parent close. */
  static confirm(title: string, text: string, opts: ConfirmOptions = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      new ConfirmModal(title, text, opts, resolve).open();
    });
  }

  private answer(value: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.resolve(value);
    this.close();
  }

  protected override onClose(): void {
    this.answer(false);
  }
}
