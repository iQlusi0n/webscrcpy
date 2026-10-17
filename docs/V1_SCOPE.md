# V1 Scope — Feature Inventory Re-cut

Every item from `FEATURE_INVENTORY.md` Part A, judged against `DESIGN_DECISIONS.md`. Verdicts: **KEEP** (v1), **DEFER** (v1.x, with trigger), **DROP** (never, with the decision that kills it), **CHANGE** (kept, but implemented differently). Section numbers mirror the inventory.

---

## A.1 Architecture & wire protocol

| Item | Verdict | Reason |
|---|---|---|
| Vanilla scrcpy-server pushed via ADB, launched with `app_process` | KEEP | D1. Push via Tango `sync:` not `adb push`. |
| One WebSocket per stream, 1-byte channel prefix (VIDEO/AUDIO/CONTROL/DEVICE_MSG/METADATA/SESSION) | KEEP | D6. Frame header mirrors scrcpy's 12 bytes verbatim; server copies without re-encode. |
| METADATA JSON once; SESSION JSON on rotation | KEEP | D6. |
| Reverse tunnel (SDK ≥ 28) / forward tunnel + dummy byte (SDK < 28) | CHANGE | Via Tango `reverse:`/`forward:` + `Bun.listen`/`Bun.connect`, no `adb` spawn. Keep the 120 s dummy-byte wait and `cleanup=false` on old SDKs. |
| Synthetic "audio disabled" socket when audio off | KEEP | Keeps `[video,audio,control]` triple uniform. |
| Congestion shedder (4 MiB / 1 MiB hysteresis, `RESET_VIDEO`, resume at keyframe) | KEEP | D6. Use `Bun.serve` `send()` return value / `getBufferedAmount()`. |
| Server stall timer (8 s) + 3× `RESET_VIDEO` retries | KEEP | Cheap, fixes real devices. |
| Client decode watchdog (5 s, max 3) + `recoverDecoder()` in place | KEEP | §25 of incumbent's guide is months of debugging; adopt. |
| Close codes 1001 / 4001–4005 / 4401 | KEEP | |
| Stuck-CLOSING socket force-terminate | KEEP | Holds the device otherwise. |
| scrcpy option allowlists (`videoEncoder`, `videoCodecOptions` regexes) | KEEP | D9 rule 6 — these strings reach `app_process` argv. |
| SDK gates (<28 forward, <30 no audio, <33 no `playback`) | KEEP | |
| Audio codec fallback (`aac → opus → flac`, else disable) | KEEP | Prevents MediaCodec crash killing video. |
| Device probe (`wm size`, `dumpsys media.player`, scrcpy `list_encoders` on SDK<28) | KEEP | Via Tango `shell:`. |

## A.2 Video/audio decode

| Item | Verdict | Reason |
|---|---|---|
| WebCodecs-only H.264/H.265/AV1/VP8/VP9 | KEEP | D5. |
| Multi-profile H.264 probe (Firefox quirk); honour definite `false`; `undefined` = unanswerable | KEEP | |
| VP8/VP9 configured from metadata | KEEP | |
| `description` built once from config packet; SPS/PPS/VPS parsers | KEEP | Need avcC/hvcC builders — see `SCRCPY_PROTOCOL.md` §3.2. |
| H.265 1088-vs-1080 coded-size handling; Edge draw-rect fix | KEEP | Known-issue list §11. |
| Canvas 2D render; rotation → `onSourceResize` updates `ScreenInfo` | KEEP | |
| Codec preference h265→h264→av1→vp8→vp9; hardware-encoder preference | KEEP | |
| Opus/AAC/FLAC/raw via `AudioDecoder` + AudioWorklet ring buffer, autoplay unlock | KEEP | |
| "No picture" detection → `/api/devices/screen-state` → locked banner; never auto-reconnect | KEEP | |

## A.3 Stream UI

| Item | Verdict | Reason |
|---|---|---|
| Configure-stream modal (codec, encoder, fps, bitrate, audio codec/source/enable, advanced: i-frame, fit, max w/h, codec options) | KEEP | Per-device settings in SQLite (D8). |
| Display dropdown | DEFER | Single entry today; implement real `list_displays` enumeration when a user asks. |
| Reset / load / save buttons | KEEP | |
| Stream modal over home page, Escape/backdrop blocked, auto-close on disconnect | KEEP | |
| Toolbar: Power, Vol±, Back, Home, Overview | KEEP | |
| Toolbar: screenshot (canvas PNG) | KEEP | |
| Toolbar: Capture keyboard / UHID / stats / refresh / clipboard get+set | KEEP | UHID and clipboard are first-class per D0. |
| Toolbar: D-pad/Touch toggle | CHANGE | Keep toggle; **Touch is the default** (D0). TV detection still flips default to D-pad. |
| Stats overlay (resolution, codec, encoder, bitrate, input/dropped/decoded FPS) | KEEP | |
| Secure-context notice naming loopback URL | CHANGE | Notice text points to the reverse-proxy help page (D12), not Local HTTPS. |

## A.4 Input

| Item | Verdict | Reason |
|---|---|---|
| All control message encoders (keycode, touch, scroll, clipboard, UHID, reset video, …) | CHANGE | Re-derive from scrcpy v5.0 (`SCRCPY_PROTOCOL.md` §4), not from the incumbent; includes types 18–22. Drop ws-scrcpy extensions 101/102 (file push goes through `sync:`). |
| Touch/mouse: shared body listeners, letterbox mapping, pointer-id map, pressure | KEEP | |
| Multi-touch simulation (Ctrl / Ctrl+Shift mirror) | KEEP | Cheap, pinch-zoom on phones matters (D0). |
| Touch-state validation (synthetic UP/DOWN) + mouseleave release | KEEP | |
| Touch mode wheel → scroll msg, 30 ms throttle, divisor 128 | KEEP | Tune divisor for phones; device only sees i16. |
| D-pad mode (click=CENTER, wheel=UP/DOWN, Shift=LEFT/RIGHT, 400 ms debounce) | KEEP | Secondary mode. |
| Right-click BACK, middle-click HOME | KEEP | |
| Keycode keyboard path (`KeyboardEvent.code` map, repeat, meta) | KEEP | |
| Text injection (type 1) | CHANGE | Incumbent never wired it. **Wire it**: non-ASCII characters have no keycode; phones need IME-less text entry. Send `INJECT_TEXT` for printable keys the keycode map can't express. |
| UHID keyboard (6KRO) + mouse (pointer lock), vendor/product 0 | KEEP | |
| Clipboard get (`COPY_KEY_COPY`) / set / device→host prompt with `execCommand` fallback | KEEP | Also use `SET_CLIPBOARD` sequence + `ACK_CLIPBOARD` (incumbent sent 0). |
| Drag-and-drop file push onto stream view | CHANGE | Keep the gesture; implement over Tango `sync:` push with native progress, not the custom 102 protocol. |

## A.5 Device tools

| Item | Verdict | Reason |
|---|---|---|
| Shell (xterm.js) | CHANGE | D10: `shell,v2,pty:` via Tango; resize/exit code in-protocol. Drop node-pty, env allowlist, `/api/capabilities {shell}` gating and its three tooltips — the shell always works if `adb` does. Keep modal rules (Escape/backdrop ignored, close-confirm when live). |
| File browser modal (breadcrumbs, filter, sort dirs-first, 6 icon types, tri-state select, size/date formatting) | KEEP | |
| Icon-size picker (16–32 px, per-user) | DROP | Settings-for-settings; pick 20 px. |
| Listing via `ls -1a` + per-entry `stat` shell parsing | CHANGE | Tango `sync:` LIST/STAT gives mode/size/mtime natively. |
| Download via `exec-out cat`, 50 MB cap | CHANGE | `sync:` RECV streamed to a `ReadableStream` → browser; no cap. |
| Bulk download (one per file, no zip) | KEEP | |
| Recursive directory download / zip | DEFER | Gap in incumbent; add if asked. |
| Upload (picker + drag-drop) via temp file + `adb push` | CHANGE | `sync:` SEND streamed straight from the browser upload; no temp file. Overwrite semantics kept. |
| Delete = `rm -rf` with protected-root allowlist, ≤1000 paths, 200/207/400 | KEEP | D9 rule 6. |
| Modal base class (native `<dialog>`, stacking, `askChild`, `closeAfter`) | KEEP | |

## A.6 Device management

| Item | Verdict | Reason |
|---|---|---|
| Device tracking | CHANGE | `host:track-devices` push stream, not 5 s `adb devices` polling. Keep property fetch with backoff, 300 ms emit throttle. |
| Screen-state poll (`dumpsys power`) per tick | KEEP | Drives sleep/wake button. Poll only while a browser is connected. |
| Device-kind detection (tv / tablet / phone) | KEEP | Only decides D-pad default and badge. |
| Device card: name, model, serial, Android, SDK; green/red state border | KEEP | |
| Inline label edit, per-user labels keyed by serial + MAC alias | CHANGE | Keep labels; drop MAC aliasing and ARP lookup (wireless-scan artefact). Key by serial only. |
| Pending-label map (10 min TTL) | DROP | Only needed when connecting by address before serial is known. |
| Disconnect button (TCP devices) | KEEP | Trivial via `host:disconnect`. |
| Sleep/wake (`input keyevent 223/224`) | KEEP | |
| Services grid: shell / files / connect / configure | KEEP | |
| Insecure-origin notice on card | KEEP | Text per D12. |
| Network discovery panel: quick scan (mDNS), scan network, subnet modal, add-subnet modal, large-subnet warning, progress chip, `/ws-scan` protocol, TCP sweep worker pool, RFC1918 guard, gateway auto-detect, persisted subnets, IDS warning, `help/subnets.html` | DEFER | D0: USB-first; `track-devices` is discovery. Revisit when wireless users ask. ~3 000 lines saved. |
| Manual connect by IP:port + label | KEEP | One input box; `host:connect`. The only wireless entry point in v1. |
| QR pairing (server-side QR, mDNS poll, `adb pair`, state machine, status poll) | DEFER | D0. v1 users run `adb pair` in a terminal. |
| Pairing-code mode | DEFER | Same. |
| `isConnectAddress` validation | KEEP | D9 rule 6. |

## A.7 Home page & shell UI

| Item | Verdict | Reason |
|---|---|---|
| Single-page home: device grid, responsive 1–5 columns | KEEP | Network-discovery section removed (deferred). |
| Dark/light theme, OS-pref first paint, per-user persisted | KEEP | |
| Welcome modal / first-run wizard | DROP | D11: no in-app service install; nothing to ask. |
| Bookmark reminder (bookmark/service kinds, per-port dismissal) | DROP | Port never auto-shifts (see A.10); nothing to remind. |
| First-run dependency banner + retry | DROP | D7: no downloads. Replace with one startup check: "adb not found — install with …" (D4). |
| Admin-scope banner (local-actionable / readonly) | DROP | D9: no admin/operator distinction. Replaced by a one-line "no password set — set one or front with an authenticating proxy" note in Settings → Access. |
| Update pill | DROP | D11: no updater. |
| Help pages: `subnets.html` | DEFER | With scan. |
| Help pages: `certificate-subject.html` | DROP | D12. Replaced by one reverse-proxy recipe page (Caddy, nginx). |
| No i18n | KEEP (as gap) | Not in v1. |

## A.8 Settings dialog

| Tab / item | Verdict | Reason |
|---|---|---|
| Tabbed dialog, staged edits, review screen `old → new`, save/discard/cancel on close, per-tab status line | DROP | D9 leaves no staged fields; Settings is one pane with direct-submit forms. |
| `pending_settings` write-ahead log | DROP | Existed to survive the port-change restart; port change is now a config-file edit + restart (A.10). |
| **Users** tab: manage users modal, enable/disable login, remote-admin checkbox + warning | CHANGE | D9: becomes **Access** — set / change / remove the single password, log out; env-set password shown read-only. |
| **Embedding** tab: approved origins, revoke, add row | DEFER | Only if the public embed API (A.16) is kept; see there. |
| **Updates** tab | DROP | D11. |
| **Service** tab | DROP | D11. |
| **Dependencies** tab | DROP | D7. Replace with a read-only "adb: /usr/bin/adb v35.0.2, scrcpy-server: 5.0 (bundled)" line under Server. |
| **Server** tab: HTTP port | CHANGE | Read-only display; set via `config.json` / env / flag. No in-app restart. |
| Server: HTTPS port, collision rules | DROP | D12. |
| Server: reset my settings | KEEP | |
| Server: change password, log out | KEEP | |
| Server: stop server & exit, restart server | DROP | systemd/docker own lifecycle (D11). |
| Server: install for all users, uninstall | DROP | D11. |
| **Local HTTPS** tab (all of it) | DROP | D12. |
| Container gating of tabs | DROP | Nothing left that's host-only. |

## A.9 HTTP/WS API & security

| Item | Verdict | Reason |
|---|---|---|
| Host allowlist, Origin check, per-launch token cookie, framing headers, 1 MiB body cap | KEEP | D9. |
| `X-Forwarded-Proto` trusted from loopback only; cookie relax to `None; Secure; Partitioned` | KEEP | D9/D12. |
| Opt-in login; scrypt; lockout; sliding sessions; hashed tokens | KEEP | D9, reduced to one password. Users, roles, last-admin guard, lockdown: DROP. |
| `requireAdmin` / `requireOperator` ladder; `ALLOW_REMOTE_ADMIN` | DROP | D9: no admin surface; gates are `public` / `auth`. Proxy does auth in mode `off`. |
| Logout/disable revokes live WS (4401) | KEEP | |
| Routes: auth/*, users/*, whoami, config GET, devices connect/disconnect/screen-state/sleep-wake/labels/files-delete, settings/*, embed-* | KEEP | |
| Routes: capabilities | DROP | Shell is unconditional. |
| Routes: config PATCH, settings/batch | CHANGE | Keep batch for the remaining staged fields (users/remote-admin); drop port/update/service keys. |
| Routes: dependencies/*, updates/*, service/*, tls/*, server/shutdown, server/restart | DROP | D7/D11/D12. |
| Routes: devices/scan*, pair/* | DEFER | With A.6. |
| WS actions: `goog-device-list`, `multiplex`, `shell`, `stream`, `list-files`, `probe` | KEEP | Collapse `list-hosts` (multi-host relic) — drop. |
| WS path `/ws-scan` | DEFER | |
| Plain-HTTP exposure modes (open/httpsOnly/redirect) | DROP | D12. |
| Container guard (409 on host-only routes) | DROP | No host-only routes remain. |

## A.10 Persistence & config

| Item | Verdict | Reason |
|---|---|---|
| SQLite `users, sessions, user_settings, devices, device_labels, device_settings, app_settings`; `user_version` migrations; shutdown backup; corrupt-store recovery | KEEP | D8, `bun:sqlite`. Drop `devices.mac`, `pending_settings`. |
| `config.json`: `webPort`, `allowedHosts`, `frameAncestors` | KEEP | D8. |
| `config.json`: `httpsPort`, `installMode`, `firstRunComplete`, `adbPath`, `dependenciesPath`, scan tunables, `server[]` | DROP | D8/D11/D12/D7. `adbPath` becomes an env var `ADB_PATH` only. |
| DB-stored `autoUpdate`, `updateCheckIntervalMinutes`, `channel`, `githubOwner`, `httpExposure`, `iconSize`, `scanSubnets` | DROP | |
| DB-stored `theme`, prompt flags (`adminScopeBannerDismissed`) | KEEP | |
| Precedence env → DB → file → default | KEEP | |
| Port auto-shift (walk +99, sibling detection via `/api/whoami`, persist rules) | DROP | A server binds the port it's told or fails loudly. Removes `/api/whoami` too. |
| Env: `DATA_ROOT`, `WS_SCRCPY_WEB_PORT`→`PORT`, `WS_SCRCPY_DOCKER`→`APP_DOCKER`, `CONFIG` path; new `AUTH_PASSWORD` | KEEP (renamed) | |
| Env: `DEPS_PATH`, `NO_BROWSER`, `OPEN_BROWSER`, `LAUNCHER`, `SERVICE`, `SCAN_CONCURRENCY`, `*_URL_BASE`, `SKIP_BOOT_LATEST`, `VELOPACK_FEED_URL`, `APPIMAGE` | DROP | No deps, launcher, updater, scan. Add `ADB_PATH`, `ADB_SERVER` (host:port for D11 Docker pattern). |
| Logging: ISO + tag, 10 MiB rotate, crash handlers | CHANGE | Log to **stdout/stderr** only; systemd/docker capture it. No file rotation code. |
| `launcher.log`, `server.log`, `service.log` | DROP | D11. |

## A.11 Local HTTPS — **DROP entirely** (D12). Replaced by the reverse-proxy help page.

## A.12 Dependency manager — **DROP entirely** (D7, D4). Replaced by a startup `adb` presence/version check and the bundled scrcpy-server asset. Optional `SCRCPY_SERVER_PATH` override, unverified, logged.

## A.13 App updater — **DROP entirely** (D11).

## A.14 Linux launcher, service, tray

| Item | Verdict | Reason |
|---|---|---|
| Rust launcher, supervisor, single-instance lock, root-trust guard, operation-server, `.restart`/exit-75 contract | DROP | D11. |
| systemd user/system units | CHANGE | Shipped as **example files** in `contrib/`, not installed by the app. `Restart=on-failure` replaces the supervisor. |
| In-app install/uninstall, `/opt` staging, SELinux relabel, teardown helpers, `--keep-state` | DROP | D11. |
| Tray (ksni) | DROP | D11. |
| AppImage, Velopack, type-2 runtime | DROP | D11: plain compiled binary. |
| Data root resolution (`DATA_ROOT` → XDG → `~/.local/share`; `/var/lib` for system unit) | KEEP | D8. |
| Browser auto-open on first spawn | DROP | Server prints its URL; a service never opens a browser. |

## A.15 Docker

| Item | Verdict | Reason |
|---|---|---|
| Image: non-root via `setpriv`, `/data` volume, conditional chown, custom-uid remediation, `HOME=/data/home` for adb keys, healthcheck on `/api/config`, `tini -g` | KEEP | Base image becomes `oven/bun` or distroless + compiled binary. |
| `adb` baked in | KEEP | D4. |
| `start.sh` restart loop | DROP | The binary is PID-1-friendly under tini; no marker/75 contract. |
| Wireless-only | CHANGE | D0/D11: document `/dev/bus/usb` passthrough and `ADB_SERVER=host.docker.internal:5037`. |
| Container-aware UI hiding service/update/HTTPS | DROP | Nothing left to hide. |
| Reverse-proxy recipe (Host, Upgrade, X-Forwarded-Proto, allowedHosts) | KEEP | D12 — this is now the *only* HTTPS doc. |
| Multi-arch | KEEP | amd64 + arm64 (`adb` exists for arm64 in Debian). |
| Publish pipeline, Scout gate, tag scheme | DEFER | CI concern, not v1 product scope. |

## A.16 Public API & embedding

| Item | Verdict | Reason |
|---|---|---|
| `WsScrcpy.startStream()` UMD/ESM + `.d.ts` | DEFER | Decide after v1: it's the incumbent's differentiator but doubles the build matrix. Keep `StreamClient` internally structured so exposing it later is a build config, not a refactor. |
| `/embed.html` + URL params | DEFER | With above. |
| Theme bridge `postMessage` | DEFER | With above. |
| Embed consent flow (`/embed-request`, 5 min TTL, approval modal) + Settings → Embedding | DEFER | With above. |
| `frameAncestors` CSP + `X-Frame-Options` | KEEP | D9 rule 4 — the header logic stays even if no UI manages the list in v1 (edit `config.json`). |

## A.17 Gaps — unchanged. Not in v1: i18n, recording, logcat viewer, multi-display, zip download, Windows.

---

## V1 at a glance

**Build**: D1–D12 stack — Bun binary, bundled scrcpy-server 5.0, user-installed `adb` via Tango server transport, WebSocket+WebCodecs, SQLite, plain HTTP behind the user's proxy.

**Ship**: device list (`track-devices`), stream with full toolbar (touch default, D-pad toggle, UHID, clipboard, screenshot, stats), configure-stream modal, shell (`shell,v2,pty:`), file browser (`sync:`), manual IP:port connect, labels, sleep/wake, theme, single-password login (or none, behind an authenticating proxy), settings (Access + Server-readonly + appearance/reset), Linux/macOS binaries, example systemd units, Dockerfile with both USB patterns, one help page (reverse proxy).

**v1.x triggers**: network scan + QR pairing (first wireless-heavy user), public embed API (first integrator), display enumeration (first multi-display device), zip download (first request).

**Removed vs. incumbent** (approximate, from Part B line counts): dependency manager, updater, launcher/tray/operation-server, Local HTTPS, network scan + pairing, service install, first-run flows, port auto-shift, file-push protocol 102, node-pty resolution — on the order of half the incumbent's non-UI code.
