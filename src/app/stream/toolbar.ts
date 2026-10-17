/**
 * Vertical toolbar: device keys (keycode down on pointerdown, up on pointerup), screenshot,
 * toggles (aria-pressed) and one-shot actions. Inline SVG icons, no dependencies.
 */
import { AndroidKey } from "./input/keycodes.ts";

export type ToggleName = "keyboard" | "uhid" | "stats" | "dpad";

export interface ToolbarCallbacks {
  key(keycode: number, down: boolean): void;
  screenshot(): void;
  refresh(): void;
  clipboardGet(): void;
  clipboardSet(): void;
  rotate(): void;
  expandNotifications(): void;
  toggle(name: ToggleName, enabled: boolean): void;
}

export type ToolbarToggles = Record<ToggleName, boolean>;

const ICONS: Record<string, string> = {
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  volumeUp: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
  volumeDown: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  overview: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  screenshot: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l1.5-3h5L16 7"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  uhid: '<rect x="8" y="2" width="8" height="20" rx="4"/><path d="M12 2v6M8 8h8"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  dpad: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 3v5h-5"/>',
  clipboardGet: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V2h6v2"/><path d="M12 9v8M9 14l3 3 3-3"/>',
  clipboardSet: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V2h6v2"/><path d="M12 17V9M9 12l3-3 3 3"/>',
  rotate: '<rect x="4" y="4" width="10" height="16" rx="2"/><path d="M17 8a4 4 0 0 1 4 4v4"/><path d="M19 14l2 2 2-2"/>',
  notifications: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly toggles: Record<ToggleName, HTMLButtonElement>;

  constructor(initial: ToolbarToggles, private readonly cb: ToolbarCallbacks) {
    this.element = document.createElement("div");
    this.element.className = "stream-toolbar";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-orientation", "vertical");

    const keys = this.group();
    keys.append(
      this.keyButton("Power", "power", AndroidKey.POWER),
      this.keyButton("Volume up", "volumeUp", AndroidKey.VOLUME_UP),
      this.keyButton("Volume down", "volumeDown", AndroidKey.VOLUME_DOWN),
      this.keyButton("Back", "back", AndroidKey.BACK),
      this.keyButton("Home", "home", AndroidKey.HOME),
      this.keyButton("Overview", "overview", AndroidKey.APP_SWITCH),
    );

    const actions = this.group();
    actions.append(
      this.actionButton("Screenshot", "screenshot", () => cb.screenshot()),
      this.actionButton("Rotate device", "rotate", () => cb.rotate()),
      this.actionButton("Expand notifications", "notifications", () => cb.expandNotifications()),
      this.actionButton("Copy device clipboard to browser", "clipboardGet", () => cb.clipboardGet()),
      this.actionButton("Send browser clipboard to device", "clipboardSet", () => cb.clipboardSet()),
      this.actionButton("Refresh stream", "refresh", () => cb.refresh()),
    );

    const toggles = this.group();
    this.toggles = {
      keyboard: this.toggleButton("Capture keyboard", "keyboard", "keyboard", initial.keyboard),
      uhid: this.toggleButton("UHID keyboard and mouse", "uhid", "uhid", initial.uhid),
      dpad: this.toggleButton("D-pad mode (off: touch)", "dpad", "dpad", initial.dpad),
      stats: this.toggleButton("Show stats", "stats", "stats", initial.stats),
    };
    toggles.append(this.toggles.keyboard, this.toggles.uhid, this.toggles.dpad, this.toggles.stats);
  }

  /** Reflect state without firing the callback. */
  setToggle(name: ToggleName, enabled: boolean): void {
    this.toggles[name].setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  isToggled(name: ToggleName): boolean {
    return this.toggles[name].getAttribute("aria-pressed") === "true";
  }

  private group(): HTMLElement {
    const g = document.createElement("div");
    g.className = "stream-toolbar-group";
    this.element.appendChild(g);
    return g;
  }

  private button(title: string, iconName: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stream-toolbar-button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon(iconName);
    return b;
  }

  private keyButton(title: string, iconName: string, keycode: number): HTMLButtonElement {
    const b = this.button(title, iconName);
    let down = false;
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      down = true;
      b.setPointerCapture(e.pointerId);
      this.cb.key(keycode, true);
    });
    const release = (): void => {
      if (!down) return;
      down = false;
      this.cb.key(keycode, false);
    };
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
        e.preventDefault();
        this.cb.key(keycode, true);
        this.cb.key(keycode, false);
      }
    });
    return b;
  }

  private actionButton(title: string, iconName: string, onClick: () => void): HTMLButtonElement {
    const b = this.button(title, iconName);
    b.addEventListener("click", onClick);
    return b;
  }

  private toggleButton(title: string, iconName: string, name: ToggleName, initial: boolean): HTMLButtonElement {
    const b = this.button(title, iconName);
    b.setAttribute("aria-pressed", initial ? "true" : "false");
    b.addEventListener("click", () => {
      const next = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", next ? "true" : "false");
      this.cb.toggle(name, next);
    });
    return b;
  }
}
