import "./ui/theme.css";
import "./ui/app.css";
import { api, errorMessage, onUnauthorized } from "./api.ts";
import { AppContext, applyTheme } from "./ui/context.ts";
import { renderHome } from "./ui/home.ts";
import { renderLogin } from "./ui/loginView.ts";
import type { UserSettings } from "@common/api.ts";

// First paint follows the OS preference; the saved theme overrides it once settings load.
applyTheme(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

const rootEl = document.getElementById("app");
if (!rootEl) throw new Error("#app missing");
const root: HTMLElement = rootEl;

let teardown: (() => void) | null = null;
let ctx: AppContext | null = null;
let bootstrapping = false;

async function bootstrap(): Promise<void> {
  if (bootstrapping) return;
  bootstrapping = true;
  teardown?.();
  teardown = null;
  for (const dialog of document.querySelectorAll("dialog.modal")) dialog.remove();
  try {
    const config = await api.config();
    if (config.auth.mode === "password" && !config.auth.loggedIn) {
      ctx = null;
      renderLogin(root, () => void bootstrap());
      return;
    }
    const settings: UserSettings = await api.settings.get().catch(() => ({}));
    if (settings.theme === "dark" || settings.theme === "light") applyTheme(settings.theme);
    ctx = new AppContext(config, settings, () => void bootstrap());
    teardown = renderHome(root, ctx);
  } catch (err) {
    root.textContent = "";
    const msg = document.createElement("div");
    msg.className = "empty-state";
    msg.textContent = `cannot reach the server: ${errorMessage(err)}`;
    const retry = document.createElement("button");
    retry.className = "btn";
    retry.textContent = "Retry";
    retry.style.marginTop = "12px";
    retry.addEventListener("click", () => void bootstrap());
    msg.append(document.createElement("br"), retry);
    root.appendChild(msg);
  } finally {
    bootstrapping = false;
  }
}

onUnauthorized(() => {
  // A 401 after bootstrap means the session was revoked (logout elsewhere, server restart).
  if (ctx) void bootstrap();
});

void bootstrap();
