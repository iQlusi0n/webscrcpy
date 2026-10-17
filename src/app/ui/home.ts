import { api, errorMessage } from "../api.ts";
import { type AppContext, currentTheme, streamBlockedReason } from "./context.ts";
import { DeviceList } from "./deviceList.ts";
import { icon } from "./icons.ts";
import { button, iconButton } from "./modal.ts";
import { SettingsModal } from "./settingsModal.ts";

/** Renders the single-page home: header, banners, connect box, device grid. Returns a teardown. */
export function renderHome(root: HTMLElement, ctx: AppContext): () => void {
  root.textContent = "";

  // ---------------------------------------------------------------- header
  const header = document.createElement("header");
  header.className = "header";
  const h1 = document.createElement("h1");
  h1.textContent = "webscrcpy";
  const version = document.createElement("span");
  version.className = "version";
  version.textContent = `v${ctx.config.version} · scrcpy ${ctx.config.scrcpyVersion}`;
  const spacer = document.createElement("span");
  spacer.className = "spacer";

  const themeBtn = iconButton("sun", "Toggle theme", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    // The theme is applied locally first; a failed PATCH only loses persistence.
    ctx.setTheme(next).catch(() => undefined);
    renderThemeIcon();
  });
  const renderThemeIcon = () => {
    themeBtn.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon"));
  };
  renderThemeIcon();

  const settingsBtn = iconButton("settings", "Settings", () => new SettingsModal(ctx).open());
  header.append(h1, version, spacer, themeBtn, settingsBtn);

  if (ctx.config.auth.mode === "password") {
    const logout = iconButton("user", "Log out", () => {
      // restart() re-fetches the config itself; a 401 here also triggers the global bootstrap, which
      // the bootstrap guard dedupes.
      api.auth
        .logout()
        .catch(() => undefined)
        .then(() => ctx.restart());
    });
    header.appendChild(logout);
  }

  // ---------------------------------------------------------------- main
  const main = document.createElement("main");
  main.className = "main";

  const adbBanner = document.createElement("div");
  adbBanner.className = "banner banner-error hidden";

  const authBanner = document.createElement("div");
  authBanner.className = "banner banner-warning";
  if (ctx.config.auth.mode === "off" && !ctx.config.callerIsLocal) {
    authBanner.append(
      document.createTextNode("No password is set: anyone who can reach this port can control your devices."),
      button("Set a password", "default", () => new SettingsModal(ctx).open()),
    );
  } else {
    authBanner.classList.add("hidden");
  }

  const insecure = document.createElement("div");
  insecure.className = "banner banner-warning";
  const blocked = streamBlockedReason();
  if (blocked) insecure.textContent = `Streaming is unavailable: ${blocked}.`;
  else insecure.classList.add("hidden");

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  const address = document.createElement("input");
  address.className = "input connect-input";
  address.placeholder = "connect ip:port";
  address.autocomplete = "off";
  const connectStatus = document.createElement("span");
  connectStatus.className = "muted";
  const connectBtn = button("Connect", "default", () => void connect());
  const connect = async () => {
    const value = address.value.trim();
    if (!value) return;
    connectBtn.disabled = true;
    connectStatus.className = "muted";
    connectStatus.textContent = "connecting…";
    try {
      const res = await api.devices.connect({ address: value });
      connectStatus.textContent = res.ok ? "connected" : (res.message ?? "connect failed");
      if (!res.ok) connectStatus.className = "error-text";
      else address.value = "";
    } catch (err) {
      connectStatus.className = "error-text";
      connectStatus.textContent = errorMessage(err);
    } finally {
      connectBtn.disabled = false;
    }
  };
  address.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void connect();
  });
  toolbar.append(address, connectBtn, connectStatus);

  const grid = document.createElement("div");
  grid.className = "device-grid";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent =
    "No devices. Plug in a phone with USB debugging enabled, or connect to a wireless device by address above.";

  main.append(adbBanner, authBanner, insecure, toolbar, grid, empty);
  root.append(header, main);

  const list = new DeviceList({ grid, empty, adbBanner }, ctx);
  list.start();
  return () => list.stop();
}
