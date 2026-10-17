# Key Design Decisions

Decision records for a browser-based Android mirroring/control app. Each entry: what we decided, why, what it costs, and what it rules out. Decisions borrowed from ws-scrcpy-web are marked; the rest are our own.

---

## D0. Audience: phones, primarily over USB

**Decision.** The primary user plugs a phone into the machine running the server and controls it from a browser on that machine or another on the LAN. Wireless (TCP/IP and Android 11+ Wireless Debugging) is supported because `adb` gives it to us (D4), but it is not the design center. TV/leanback boxes are supported incidentally, not targeted.

**Consequences, in priority order.**
- **USB requires the host `adb` daemon** — there is no pure-JS USB path that honours D3 (no native addons). This is what makes D4 a settled decision rather than a trade-off.
- **Docker is a secondary deployment**, because the incumbent's "wireless-only container" story does not serve a USB-first user. The container must reach the host's `adb` daemon: either `--device /dev/bus/usb` + `adb` inside the image, or (preferred) the host runs `adb -a nodaemon server` and the container points Tango's server transport at `host.docker.internal:5037`. Document both; the second keeps USB enumeration and udev rules on the host where they belong.
- **Touch mode is the default** input mode; D-pad mode stays as a toggle (TVs still exist). UHID keyboard+mouse and bidirectional clipboard are first-class, not extras.
- **Device discovery is `host:track-devices`**, not a network scan: USB devices appear the moment they are plugged in and authorised. Port-5555 subnet sweeps, mDNS, QR pairing and subnet dialogs move to a later milestone (they cost the incumbent ~3 000 lines and a help page).
- **Pairing UI** (Android 11+ `adb pair`) is a v1.x feature; v1 users who want wireless run `adb tcpip 5555` or `adb pair` once in a terminal.
- File browser via `sync:` and the shell via `shell,v2,pty:` are in scope for v1 — a phone on a cable is exactly where "pull that screenshot / push that APK" happens.

**Rules out (v1).** Network scanning, QR pairing, subnet configuration, device-kind-driven defaults beyond phone/tablet.

---

## D1. Vanilla scrcpy-server *(borrowed)*

**Decision.** Use unmodified Genymobile `scrcpy-server` binaries. No Java patches, no fork.

**Why.** scrcpy is the only mature, actively maintained Android screen-capture + input-injection server. A fork means re-applying patches on every upstream release and owning Android-version breakage ourselves. Vanilla means drop-in upgrades verified by upstream's own `SHA256SUMS.txt` + OpenPGP signature.

**Consequences.**
- We speak scrcpy's wire protocol exactly (v4: 12-byte packet headers, PTS flag bits 63/62/61, 80-byte opening metadata, control message type bytes). Any protocol change upstream is a change for us.
- Anything scrcpy-server can't do (e.g. per-app streaming before scrcpy 3.x, custom overlays) we don't do.
- The server is a plain file pushed via ADB `sync:` to `/data/local/tmp` and launched with `app_process`; nothing is installed on the device.

**Rules out.** Any feature requiring device-side code we control.

---

## D2. Pure browser code *(borrowed)*

**Decision.** The browser bundle contains no Node/Bun polyfills (`Buffer`, `path`, `events`, `stream`). All protocol code is written against `Uint8Array`/`DataView`/`ReadableStream`.

**Why.** Polyfills bloat the bundle, hide platform differences, and make the public embed library heavier than it needs to be. Shared protocol modules (`src/common/`) run unchanged in browser and Bun because both expose the same Web APIs.

**Consequences.** Shared code may only import from `src/common/` and Web standard globals. Enforced by a lint rule (`no-restricted-imports` on `node:*`/`bun:*` in `src/app/` and `src/common/`).

---

## D3. Bun runtime, not Node.js

**Decision.** The server runs on Bun (≥ 1.3.5). We ship `bun build --compile` single-file executables per platform.

**Why.** Four of ws-scrcpy-web's heaviest runtime problems are artifacts of Node, and Bun removes them outright:

| ws-scrcpy-web problem | Cause | Bun |
|---|---|---|
| Downloads Node.js (~50 MB) at first run, verifies with OpenPGP, needs supervisor restart (exit 75) to swap it | Node must be a separate binary beside the app | `bun build --compile` embeds the runtime; the app *is* the binary. No runtime download, no runtime updater. |
| Downloads `node-pty` native prebuilt matched to Node ABI; weekly CI to build it; shell greys out if no match; musl unsupported | Interactive shell needs a PTY; Node has none | Not needed at all — the shell uses a device-side PTY (D10). If a local PTY were ever needed, `Bun.spawn(cmd, { terminal })` is built in (1.3.5+, POSIX). Zero native addons. |
| webpack + swc + dts-bundle-generator + separate TS 6/7 toolchains | Node has no bundler | `Bun.build` bundles server, browser, UMD/ESM lib; `bun test` runs tests. One toolchain. |
| `ws` package, `node:sqlite` (experimental), manual backpressure via `bufferedAmount` | Node stdlib gaps | `Bun.serve({ websocket })` with native per-socket backpressure (`send()` returns -1/0/N) and pub/sub; `bun:sqlite` stable; `Bun.connect` raw TCP for the scrcpy tunnel. |

**Costs / risks.**
- **Native addons** are not a safe path on Bun (N-API coverage is partial). Rule: **no native addons, ever.** Every dependency must be pure JS/TS. This is a feature — it is what makes `--compile` trivially portable.
- **Velopack** (ws-scrcpy-web's updater) has no Bun story. We don't ship an updater at all (D11).
- **Windows PTY** is not implemented in Bun. Out of scope (D11).
- **Ecosystem edge cases**: `node:` compat is good but not total. Mitigation: `bun test` on every PR, no transitive native deps (`bun pm ls` check in CI).
- **Bun's own release cadence** is fast and occasionally regresses. Pin the Bun version in `package.json` `packageManager`/`.bun-version` and in CI; upgrade deliberately.

**Rules out.** Any package with a `.node` binary; Electron-style packaging; Node-only hosting.

---

## D4. `adb` is a user-provided prerequisite, never downloaded

**Decision.** The user installs Google's `adb` (`apt install adb`, `brew install android-platform-tools`, or the Docker image which bakes it in). We talk to its daemon on `localhost:5037` through a pure-TypeScript ADB client (Tango, `@yume-chan/adb` — zero deps, Web-Streams based, server transport over `Bun.connect`). We do **not** download platform-tools, and we do not reimplement the daemon protocol.

**Why — versus building ADB support ourselves.**
- Building it is 3–5 weeks for the Android 11+ wireless-debugging path (STARTTLS with a client cert over a live `Bun.connect` socket, SPAKE2+ pairing over `@noble/curves` from the AOSP spec, pure-TS mDNS) with a hard-stop risk if Bun's TLS upgrade can't present a client certificate. Tango implements none of those (verified against tangoadb.dev v2.6: *"The Wireless Debugging connection is not implemented yet"*). Google's binary provides USB, wireless debugging, pairing, mDNS and every future protocol change for free.
- "User installs `adb`" is a prerequisite like Docker or a browser, not a download *we* perform — so D7 (zero runtime downloads) still holds in spirit: our binary fetches nothing.
- Every ADB pain in ws-scrcpy-web came from *downloading* it (XML index, SHA-1 check, swap-and-restart, no arm64 build), not from using it. Requiring it installed removes all of those.

**Why Tango's server transport rather than spawning `adb` and parsing stdout.** Typed, streamed access to `sync:` (push/pull/list/stat — no `exec-out cat` with a 50 MB cap, no `stat` output parsing), `shell,v2,pty:` (device-side PTY with resize and exit codes), `reverse:`/`forward:`, and `host:track-devices` as first-class calls. The only spawns left are `adb pair` and `adb mdns services`, which have no daemon-protocol equivalent — two line-oriented commands.

**Costs / risks.**
- A non-technical user on a bare machine gets "adb not found" on first run. Mitigation: a precise startup error naming the one-line install command for the detected OS, and the Docker image as the zero-setup path.
- We depend on the daemon being up; we start it (`adb start-server`) if the port is closed, same as every ADB client.
- Tango's public API is marked unstable; pin the version.

**Rules out.** Shipping or updating `adb` ourselves; any device access path that bypasses the host daemon.

---

## D5. WebCodecs-only decode in the browser *(borrowed)*

**Decision.** Video and audio decoding in the browser go through `VideoDecoder`/`AudioDecoder`. No WASM decoders (Broadway, tinyh264, ffmpeg.wasm), no MSE.

**Why.** Hardware decode, lowest latency, every codec scrcpy emits (H.264/H.265/AV1/VP8/VP9, Opus/AAC/FLAC/PCM) with one API, ~zero bundle cost. WASM software decode of 1080p H.265 is not viable on low-end laptops; MSE adds its own buffering latency.

**Known cost — the secure-context wall.** WebCodecs is `[SecureContext]`. `http://<lan-ip>:8000` lists devices but cannot stream. Remedies: open the app on the serving machine (`http://localhost`), or put a TLS-terminating reverse proxy in front (D12). We do nothing about it in-app. Chromium's `--unsafely-treat-insecure-origin-as-secure` does not restore WebCodecs (measured by ws-scrcpy-web).

---

## D6. Transport: one WebSocket per stream *(borrowed)*

**Decision.** One WebSocket per stream, 1-byte channel prefix multiplexing video / audio / control / device-messages / metadata / session-change. Media frames carry `[8B PTS+flags][4B len][data]`, mirroring scrcpy's own framing so the server copies bytes without re-encoding.

**Why.** Works through every reverse proxy, inherits HTTP auth cookies and the Origin/Host checks (D9), trivial to embed in an iframe, no extra ports, no UDP. Bun's native WebSocket server gives per-socket backpressure for free.

**Known weakness and mitigation.** TCP head-of-line blocking: a slow *browser* (not a bad network) makes the server buffer unboundedly. Adopt ws-scrcpy-web's shedder: `bufferedAmount > 4 MiB` → drop video+audio (never config packets); `≤ 1 MiB` → send `TYPE_RESET_VIDEO`, drop deltas until the next keyframe, resume. Keep the transport behind a `StreamTransport` interface on both sides so nothing above it knows it is a WebSocket; no second transport is planned.

---

## D7. One binary, zero runtime downloads

**Decision.** The shipped artifact is self-sufficient: Bun runtime (embedded by `--compile`), scrcpy-server (embedded as an asset, verified at build time against Genymobile's signed `SHA256SUMS.txt`), browser bundle, help pages. First run downloads **nothing**. The only external prerequisite is `adb` (D4).

**Why.** Follows from D3 + D4. ws-scrcpy-web's "dependency manager" (Node/ADB/scrcpy-server/mkcert, four verification schemes, a first-run banner, a retry flow, an air-gap guide) exists to work around runtime downloads. Not downloading is simpler than verifying downloads.

**Consequences.** Updating scrcpy-server = new app release (acceptable: scrcpy releases a few times a year; we track it in CI). Optional *newer* scrcpy-server override via a config path for power users — unverified, their responsibility, logged loudly.

---

## D8. Data & config *(borrowed with changes)*

- **SQLite** (`bun:sqlite`, WAL mode) for everything that is not needed before the server is up: sessions, settings, device labels, per-device stream settings, app settings (incl. the password hash). No user_id columns — there is one operator (D9). Schema versioned by `PRAGMA user_version`, forward-only migrations.
- **`config.json`** for the boot-time set only: `port`, plus server-only security lists `allowedHosts`, `frameAncestors`. (No `installMode`/`firstRunComplete`: there is no launcher and no in-app service installer, see D11.)
- **Precedence**: env var → SQLite → `config.json` → default.
- **Data root**: `$DATA_ROOT` → `$XDG_DATA_HOME/<app>` → `~/.local/share/<app>`; the example system unit sets `DATA_ROOT=/var/lib/<app>`; never `/tmp`, never silently.

---

## D9. Security model *(borrowed, auth simplified)*

Adopt ws-scrcpy-web's request-gating layers; drop its user/role system.

1. Host allowlist (`localhost`, IP literals, configured domains) → DNS-rebinding defence on every request.
2. Origin == Host on `/api/*` and all non-GET → CSRF.
3. Per-launch random token cookie on document loads, required on `/api/*` and WS upgrades → blind cross-site requests fail.
4. `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors` opt-in list → clickjacking.
5. **One optional password, no accounts.** Mode `password`: set via `AUTH_PASSWORD` or Settings; scrypt hash, 5-fails/5-min → 15-min lockout, 30-day sliding session cookie stored as SHA-256, logout revokes all sessions and live sockets. Mode `off`: no login at all; the operator puts an authenticating reverse proxy in front (Traefik forward-auth, Caddy `basic_auth`, nginx `auth_request`, OIDC proxy). There is no "admin" surface distinct from "user", so the incumbent's operator-proof ladder, `ALLOW_REMOTE_ADMIN`, roles, lockdown and last-admin guards all go.
6. Every device-targeting string (serial, address, path, encoder name, codec options) validated against an allowlist regex *before* it reaches any shell or protocol call.

**Why one password.** The product is one person's phone(s) behind one server. Multi-user, roles and remote-admin proof exist in the incumbent because it tried to be safe when opened to a LAN *without* a proxy; our stated deployment (D12) already has a proxy in front for anything beyond localhost, and proxies do authentication better than we will. The single password covers the "I just run it on my laptop" case; everything else is the proxy's job.

**Proxy awareness (D12).** The server listens on plain HTTP only. `X-Forwarded-Proto: https` is honoured **only when the TCP peer is loopback** (the documented proxy-on-the-same-host deployment); it decides whether cookies get `Secure` and whether cross-site embedding (`SameSite=None; Secure; Partitioned`) is possible. From any other peer the header is ignored. Operators who proxy from another host put the app behind a `allowedHosts` domain and keep the proxy as the only thing that reaches the port.

---

## D10. Interactive shell via device-side PTY, no native dependency

**Decision.** Ship the terminal (xterm.js) because TV/sideloading users need `pm install`, `logcat`, `settings put`. Implement via ADB `shell,v2,pty:` through Tango (D4) — the PTY lives on the Android device, resize and exit codes are in the protocol, no server PTY, no node-pty. **Zero native addons** (D3).

---

## D11. Platform scope and packaging

**Decision.**
- **Linux**: a single `bun build --compile` binary (x64 and arm64). Shipped alongside **example** systemd units — `app.service` for `~/.config/systemd/user/` and a system-scope variant with `DATA_ROOT=/var/lib/<app>` — that the user copies and enables. No AppImage, no installer, no in-app service install/uninstall, no launcher process, no tray.
- **Docker**: a `Dockerfile` (multi-arch, `adb` baked in, non-root, `/data` volume, healthcheck on `GET /api/config`) and a `docker-compose.yml` bound to loopback. Because the audience is USB-first (D0), the compose file shows both device-access patterns: `devices: ["/dev/bus/usb"]` for in-container `adb`, and `ADB_SERVER=host.docker.internal:5037` for a host-side daemon started with `adb -a nodaemon server`.
- **macOS**: the same compiled binary; `launchd` plist example if someone asks.
- **No Windows. No iOS.**

**Updates.** None in-app. Users download the new binary (or `docker pull`) and restart; the data root is untouched. This deletes ws-scrcpy-web's entire updater surface (Velopack, channels, AppImage swap helper, operation-server "please wait" page, `.restart` markers, exit-75 supervisor contract).

**Why.** Everything removed here was built by the incumbent to serve a double-click desktop-app expectation on Windows. Our audience runs a server: a binary + a unit file + a container is the native idiom, and each of the removed pieces (launcher, tray, operation-server, uninstall helpers, root-trust guard, SELinux relabelling) exists only because the app tried to install *itself*.

**Rules out.** First-run welcome wizard; "install as service" buttons; crash-restart supervision (systemd's `Restart=on-failure` does it); tray icon.

---

## D12. No TLS in the app; the user provides HTTPS

**Decision.** The server binds one plain-HTTP listener. There is no HTTPS listener, no certificate generation, no `mkcert`, no CA download, no `httpsPort`, no "plain-HTTP exposure" mode. Anyone who needs `https://` — which is anyone streaming from a machine other than the server — puts a TLS-terminating reverse proxy in front (Caddy, nginx, Traefik, Tailscale Serve, a NAS's built-in proxy).

**Why.** ws-scrcpy-web's Local HTTPS feature is ~2 000 lines plus a 400-line help page: a vendored and provenance-verified `mkcert`, subject-name validation against the public-suffix list, name-constrained CAs, cert/key path rules per OS, listener-state notices (restart-required / port-collision / bind-failed / stale leaf), per-OS CA-install instructions including Android and iOS, and an exposure-mode state machine — all to reproduce what one Caddyfile block does. Our audience already runs a server; a reverse proxy is the idiom they expect, it gets them real certificates, and it is the only option the incumbent supports in Docker anyway.

**Documented contract for the proxy** (same three rules as the incumbent, now the whole HTTPS story):
1. Add the public name to `allowedHosts` (D9 Host allowlist) or every request is refused as DNS rebinding.
2. Forward `Host` unchanged, or the Origin check (D9) rejects every API call.
3. Forward `Upgrade`/`Connection` headers — streams, shell and scan are WebSockets.
4. Optionally `X-Forwarded-Proto: https` from a loopback proxy, for `Secure` cookies and cross-site embedding.

Help page ships Caddy and nginx recipes. The device card's "not a secure origin" notice (D5) links to it.

**Costs.** A home user on a bare machine who wants to stream from a second device must set up a proxy; the incumbent's one-click Local HTTPS was friendlier for exactly that case. Accepted: the proxy recipe is two lines in Caddy, and the alternative is owning a certificate authority.

**Rules out.** `https://` served by the app; the Local HTTPS settings tab; CA/certificate UI.

---

## Summary table

| # | Decision | Primary driver |
|---|---|---|
| D0 | Phones over USB; wireless via `adb`, TV incidental | Settles D4; discovery = `track-devices`, scan/pairing deferred |
| D1 | Vanilla scrcpy-server | Upstream maintenance |
| D2 | Pure browser code | Bundle size, shared protocol code |
| D3 | Bun, single compiled binary, no native addons | Removes Node/node-pty/webpack/Velopack |
| D4 | User-provided `adb`; Tango server transport, no stdout parsing | 3–5 weeks saved; USB + Android 11+ pairing for free |
| D5 | WebCodecs decode | Latency, codec breadth |
| D6 | One WebSocket per stream, channel-prefixed | Proxy-friendly, cookie-authenticated, no UDP |
| D7 | Zero runtime downloads | Follows from D3+D4 |
| D8 | SQLite + boot-only config.json | Borrowed |
| D9 | Layered security model | Borrowed |
| D10 | Shell via device PTY | No native deps |
| D11 | Linux binary + example units, Dockerfile, macOS binary; no updater, no installer, no Windows | Server idiom; deletes the launcher/tray/updater surface |
| D12 | No TLS in-app; user supplies a reverse proxy | Deletes the mkcert/CA/listener surface; proxy is the server idiom |
