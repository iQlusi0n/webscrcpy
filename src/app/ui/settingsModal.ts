import { api, errorMessage } from "../api.ts";
import { ConfirmModal } from "./confirm.ts";
import { type AppContext, clearCachedTheme, currentTheme } from "./context.ts";
import { button, Modal } from "./modal.ts";

function sectionTitle(text: string): HTMLHeadingElement {
  const h = document.createElement("h3");
  h.className = "settings-section-title";
  h.textContent = text;
  return h;
}

function row(label: string, hint: string | null, control: HTMLElement): HTMLDivElement {
  const r = document.createElement("div");
  r.className = "settings-row";
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    l.appendChild(small);
  }
  r.append(l, control);
  return r;
}

function readOnly(label: string, value: string): HTMLDivElement {
  const v = document.createElement("span");
  v.className = "mono";
  v.textContent = value;
  return row(label, null, v);
}

function passwordInput(placeholder: string, autocomplete: AutoFill): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "password";
  i.className = "input";
  i.placeholder = placeholder;
  i.autocomplete = autocomplete;
  i.required = true;
  return i;
}

function note(text: string, kind: "" | "note-warning" | "note-error" = ""): HTMLDivElement {
  const n = document.createElement("div");
  n.className = `note ${kind}`.trim();
  n.textContent = text;
  return n;
}

export class SettingsModal extends Modal {
  private readonly ctx: AppContext;
  private readonly pane = document.createElement("div");

  constructor(ctx: AppContext) {
    super({ title: "Settings" });
    this.ctx = ctx;
    this.body.appendChild(this.pane);
    this.render();
    const close = button("Close", "default", () => this.close());
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    this.footer.append(spacer, close);
  }

  private render(): void {
    this.pane.textContent = "";
    this.pane.append(sectionTitle("Access"), ...this.accessSection());
    this.pane.append(sectionTitle("Server"), ...this.serverSection());
    this.pane.append(sectionTitle("Appearance"), ...this.appearanceSection());
  }

  // ---------------------------------------------------------------- access

  private accessSection(): HTMLElement[] {
    const { auth } = this.ctx.config;
    const out: HTMLElement[] = [];
    if (auth.fromEnv) {
      out.push(note("password is set by AUTH_PASSWORD; change it there"));
      if (auth.mode === "password")
        out.push(
          row(
            "Log out",
            "ends every session",
            button("Log out", "default", () => void this.logout()),
          ),
        );
      return out;
    }
    if (auth.mode === "off") {
      out.push(
        note(
          "No password set. Anyone who can reach this port can control devices; either set a password here or put an authenticating reverse proxy in front.",
          "note-warning",
        ),
      );
      out.push(this.passwordForm("Set password", null));
      return out;
    }
    out.push(this.passwordForm("Change password", "current-password"));
    out.push(
      row(
        "Remove password",
        "anyone who can reach this port will control devices",
        button("Remove", "danger", () => void this.removePassword()),
      ),
    );
    out.push(
      row(
        "Log out",
        "ends every session",
        button("Log out", "default", () => void this.logout()),
      ),
    );
    return out;
  }

  /** `current` null → mode 'off' form (no current password field). */
  private passwordForm(title: string, current: "current-password" | null): HTMLFormElement {
    const form = document.createElement("form");
    form.style.margin = "8px 0";
    const currentInput = current ? passwordInput("current password", current) : null;
    const next = passwordInput("new password", "new-password");
    next.minLength = 1;
    const confirm = passwordInput("repeat new password", "new-password");
    const status = document.createElement("div");
    status.className = "modal-status";
    status.style.minHeight = "1.4em";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "btn btn-primary";
    submit.textContent = title;
    const fields = document.createElement("div");
    fields.className = "row";
    fields.style.flexWrap = "nowrap";
    if (currentInput) fields.appendChild(currentInput);
    fields.append(next, confirm, submit);
    form.append(fields, status);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      status.className = "modal-status";
      if (next.value !== confirm.value) {
        status.className = "modal-status error-text";
        status.textContent = "passwords do not match";
        return;
      }
      submit.disabled = true;
      void (async () => {
        try {
          const body = currentInput
            ? { currentPassword: currentInput.value, newPassword: next.value }
            : { newPassword: next.value };
          await api.auth.setPassword(body);
          await this.ctx.refreshConfig();
          status.textContent = "saved";
          // Setting a password from mode 'off' does not log this browser in: go through the login view.
          if (this.ctx.config.auth.mode === "password" && !this.ctx.config.auth.loggedIn) {
            this.close();
            this.ctx.restart();
            return;
          }
          this.render();
        } catch (err) {
          status.className = "modal-status error-text";
          status.textContent = errorMessage(err);
        } finally {
          submit.disabled = false;
        }
      })();
    });
    return form;
  }

  private async removePassword(): Promise<void> {
    const ok = await this.askChild(
      () =>
        ConfirmModal.confirm(
          "Remove password?",
          "Anyone who can reach this port will be able to control connected devices.",
          { ok: "Remove", danger: true },
        ),
      false,
    );
    if (!ok) return;
    const current = await this.askChild(() => PromptModal.prompt("Current password", "password"), null);
    if (current === null) return;
    try {
      await api.auth.setPassword({ currentPassword: current, newPassword: "" });
      await this.ctx.refreshConfig();
      this.render();
    } catch (err) {
      this.pane.prepend(note(errorMessage(err), "note-error"));
    }
  }

  private async logout(): Promise<void> {
    try {
      await api.auth.logout();
    } catch {
      // the session may already be gone; either way we fall through to the login view
    }
    this.close();
    await this.ctx.refreshConfig().catch(() => undefined);
    this.ctx.restart();
  }

  // ---------------------------------------------------------------- server

  private serverSection(): HTMLElement[] {
    const { config } = this.ctx;
    const adb = config.adb.ok
      ? `${config.adb.path ?? "adb"}${config.adb.version ? ` (${config.adb.version})` : ""}`
      : `unavailable${config.adb.message ? `: ${config.adb.message}` : ""}`;
    return [
      readOnly("Port", `${config.port}  (set via PORT / config.json; restart to apply)`),
      readOnly("adb", adb),
      readOnly("scrcpy-server", `${config.scrcpyVersion} (bundled)`),
      readOnly(
        "Data root",
        config.docker ? "/data (container volume)" : "$DATA_ROOT → $XDG_DATA_HOME/webscrcpy → ~/.local/share/webscrcpy",
      ),
      readOnly("Version", config.version),
    ];
  }

  // ---------------------------------------------------------------- appearance

  private appearanceSection(): HTMLElement[] {
    const theme = document.createElement("select");
    theme.className = "select";
    theme.style.width = "auto";
    theme.add(new Option("dark", "dark"));
    theme.add(new Option("light", "light"));
    theme.value = currentTheme();
    theme.addEventListener("change", () => {
      this.ctx.setTheme(theme.value === "light" ? "light" : "dark").catch(() => undefined);
    });
    const reset = button("Reset", "danger", () => void this.resetSettings());
    return [
      row("Theme", null, theme),
      row("Reset my settings", "theme and UI preferences (device labels and stream settings are kept)", reset),
    ];
  }

  private async resetSettings(): Promise<void> {
    const ok = await this.askChild(
      () =>
        ConfirmModal.confirm(
          "Reset settings?",
          "Theme and UI preferences return to their defaults. Device labels and per-device stream settings are kept.",
          { ok: "Reset", danger: true },
        ),
      false,
    );
    if (!ok) return;
    try {
      await api.settings.reset();
      clearCachedTheme();
      location.reload();
    } catch (err) {
      this.pane.prepend(note(errorMessage(err), "note-error"));
    }
  }
}

/** Single-field prompt; resolves null on cancel. */
class PromptModal extends Modal {
  private answered = false;
  private readonly input = document.createElement("input");

  private constructor(
    title: string,
    type: string,
    private readonly resolve: (value: string | null) => void,
  ) {
    super({ title, className: "modal-auto" });
    this.input.type = type;
    this.input.className = "input";
    this.input.autocomplete = type === "password" ? "current-password" : "off";
    this.input.style.minWidth = "280px";
    const form = document.createElement("form");
    form.appendChild(this.input);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.answer(this.input.value);
    });
    this.body.appendChild(form);
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    this.footer.append(
      spacer,
      button("Cancel", "default", () => this.close()),
      button("OK", "primary", () => this.answer(this.input.value)),
    );
  }

  static prompt(title: string, type: string): Promise<string | null> {
    return new Promise((resolve) => {
      const m = new PromptModal(title, type, resolve).open();
      m.input.focus();
    });
  }

  private answer(value: string | null): void {
    if (this.answered) return;
    this.answered = true;
    this.resolve(value);
    this.close();
  }

  protected override onClose(): void {
    this.answer(null);
  }
}
