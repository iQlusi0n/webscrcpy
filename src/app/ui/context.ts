/** Shared, mutable app state handed to every view: server config, user settings, theme. */
import type { ConfigResponse, UserSettings } from "@common/api.ts";
import { api } from "../api.ts";

export type Theme = "dark" | "light";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export class AppContext {
  config: ConfigResponse;
  settings: UserSettings;
  /** re-runs the bootstrap (login view or home) after a config change such as login/logout */
  readonly restart: () => void;

  constructor(config: ConfigResponse, settings: UserSettings, restart: () => void) {
    this.config = config;
    this.settings = settings;
    this.restart = restart;
  }

  async refreshConfig(): Promise<ConfigResponse> {
    this.config = await api.config();
    return this.config;
  }

  async setTheme(theme: Theme): Promise<void> {
    applyTheme(theme);
    this.settings = { ...this.settings, theme };
    await api.settings.patch({ theme });
  }
}

/** Why streaming is impossible on this page, or null when WebCodecs is usable. */
export function streamBlockedReason(): string | null {
  if (!window.isSecureContext) {
    return `this page is not a secure origin; open http://localhost:${location.port || 80} on the server machine or put the app behind an HTTPS reverse proxy`;
  }
  if (typeof VideoDecoder !== "function") {
    return "this browser has no WebCodecs VideoDecoder; use a current Chromium, Edge, Firefox or Safari";
  }
  return null;
}
