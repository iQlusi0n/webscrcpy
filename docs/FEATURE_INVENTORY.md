# ws-scrcpy-web — Feature Inventory & Competitor Build Spec

Generated 2026-10-13 from the repository at this path (README, `docs/TECHNICAL_GUIDE.md`, and code-level review of `src/`, `launcher/`, `common/`, `docker/`). **Windows-only behavior is excluded** (MSI, Servy service, UAC, Windows tray helper, Job Object, `start.cmd`, portable ZIP).

Part A is the condensed spec. Part B is the full per-subsystem detail with file/line citations. Items marked `[unverified]` were not confirmed in code.

---

# Part A — Condensed specification

## A.1 Architecture & wire protocol

**Model**: Node server uses ADB to push vanilla Genymobile `scrcpy-server` to the device, launches it via `app_process`, and bridges its 3 TCP sockets (video, audio, control) onto **one WebSocket** per stream. Browser demuxes and decodes via WebCodecs only (no WASM/MSE/Broadway).

**WS framing**: `[1 byte channel][payload]`

| Channel | ID | Dir | Payload |
|---|---|---|---|
| VIDEO | 0 | S→B | `[8B PTS+flags BE][4B len BE][data]` |
| AUDIO | 1 | S→B | same |
| CONTROL | 2 | B→S | raw scrcpy control message, written verbatim to control socket |
| DEVICE_MSG | 3 | S→B | raw control-socket chunks (clipboard/ack/UHID output); browser reassembles; unknown type halts reassembly for the connection |
| METADATA | 4 | S→B | JSON `{deviceName, videoCodec, screenWidth, screenHeight, audioCodec, videoEncoder?}` once; `audioCodec` may be `'disabled'`/`'error'` |
| SESSION | 5 | S→B | JSON `{width,height}` on rotation/resize |

PTS flag bits (scrcpy v4): bit 63 session packet, bit 62 config, bit 61 keyframe. Opening metadata packet on video socket = 80 bytes (64B name, 4B codec id, 4B flags w/ MSB required, 4B w, 4B h). Audio socket opens with 4B codec id or `0x0` disabled / `0x1` error.

**Tunnels**: SDK ≥ 28 → `adb reverse localabstract:scrcpy_<scid>`; host listens, waits 10 s for 2–3 sockets. SDK < 28 → `adb forward`, host dials, waits up to 120 s for scrcpy's dummy `0x00` byte (retry 150 ms), 15 s per-socket connect; `cleanup=false`. Audio-off → synthetic disabled socket spliced in so triple shape is uniform.

**Server-side congestion shedding** (`StreamCongestion`): per packet check `ws.bufferedAmount`. `>4 MiB` → shed video+audio (never config); `≤1 MiB` → send `TYPE_RESET_VIDEO` (17), drop deltas until keyframe, then flowing. Three log lines (congested/drained/resumed).

**Keyframe recovery**: 8 s stall timer after start; if no config packet, send `TYPE_RESET_VIDEO` up to 3× at 2 s intervals. Client-side decode watchdog (5 s, re-armed on each configure, max 3 requests/session) emits `video-stalled` → same control byte. Decoder `error` → `recoverDecoder()` recreates `VideoDecoder` in place without ending session.

**Close codes**: normal = none (1005); shutdown = 1001; session failed = 4005 w/ reason (capped length); 4001 invalid url; 4002 unsupported action; 4003 missing udid; 4401 unauthorized (revoked session). Stuck-CLOSING sockets force-terminated after grace.

**scrcpy-server options** (defaults): `videoCodec` h264, `audioCodec` opus, `audioSource` output, `audioDup` false (auto-true for `playback`), `maxSize` 0, `videoBitRate` 8 000 000, `maxFps` 0, `audio` true, `control` true, `displayId` 0, `videoEncoder` (regex `^[A-Za-z0-9_.-]{1,128}$`), `videoCodecOptions` (`^[A-Za-z0-9_.:,=-]{1,256}$`) — both allowlisted as shell-injection guards. SDK gates: <28 forward tunnel; <30 force audio off; <33 + playback → audio off. Server pushed only if missing/size differs. Query params: `maxSize, bitrate, maxFps, displayId, videoCodec, audioCodec, audio, audioSource, videoEncoder, videoCodecOptions`.

**Audio codec fallback** (`chooseAudioCodec`): raw untouched; empty encoder list = unknown, leave as-is; match by dotted segment (`.opus.`); fallback order `aac → opus → flac`; nothing → disable audio rather than crash MediaCodec. Logs reason every session.

**Device probe** (`action=probe`): `{width, height, density, sdkInt, videoEncoders[], audioEncoders[]}` from `wm size`/`wm density` + `dumpsys media.player` (or scrcpy `list_encoders=true` for SDK<28).

## A.2 Video/audio decode (browser)

- Video: H.264 (probe 3 profile strings for Firefox quirk), H.265 `hev1.1.6.L93.B0`, AV1 `av01.0.04M.08`, VP8, VP9 `vp09.00.10.08`. `isConfigSupported` definite `false` is honored; `undefined` = unanswerable. VP8/VP9 configured from metadata (no usable config packet).
- Config via `VideoDecoderConfig.description` once at configure; SPS/PPS/VPS parsers for h264/h265/av1.
- H.265 coded-vs-display dimension handling (1088 vs 1080); Edge draw-rect fix.
- Canvas 2D rendering; rotation via SESSION packet → `onSourceResize` updates `ScreenInfo` so touch mapping stays correct without reconnect.
- Codec selection: preference `h265 → h264 → av1 → vp8 → vp9`, intersect device encoders ∩ browser decode; hardware encoder preferred (anything not `c2.android.*`/`OMX.google.*`); default encoder pick `/\.(mtk|qcom|exynos)\.hevc\./`. Explicit unsupported codec silently rewritten to h264.
- Audio: `AudioContext({latencyHint:'interactive', sampleRate:48000})`, AudioWorklet ring buffer from Blob URL, 2 channels, GainNode volume. Opus configures immediately; AAC (`mp4a.40.2`)/FLAC wait for config packet; raw = S16LE→Float32 planar, no decoder. Autoplay unlock on first click/keydown. Idempotent `stop()`.
- "No picture" detection: rolling 30-frame avg encoded size; `<10% of baseline` or `<1000 B` for 5 consecutive checks → query `/api/devices/screen-state` (throttled 5 s) → banner *"device is locked — unlock it to see the screen"*. Never auto-reconnects (explicitly removed).

## A.3 Stream UI

**Configure-stream modal** (native `<dialog>`): display dropdown (single entry today), video codec (filtered by browser support, defaults to H.265 if offered), encoder (blank = auto), max fps slider 1–60, audio codec (opus/aac/flac + always raw), audio source (output always; playback if SDK≥33; mic always), enable-audio checkbox (disabled SDK<30), bitrate slider 512 KiB–8 MiB step 512 KiB. Advanced: i-frame interval (sent but documented as not honored), fit-to-screen (disables max w/h), max width/height, free-form codec options (user's `i-frame-interval:` wins). Buttons: reset / load / save (per device+display, SQLite-backed `device_settings`, "saved" flash 1.5 s). Status line: probing / ready / error; connect disabled until probe done; insecure-context → error notice.

**Stream modal** (`ConnectModal`): opens over home page; Escape/backdrop blocked while streaming; `onDisconnect` auto-closes; `onError` shows red inline error and closes after 4 s. Fit-to-screen bounds = `(innerWidth − toolbar) & ~15 × innerHeight & ~15`.

**Toolbar**: Power, Vol+, Vol−, Back, Home, Overview (keycode down/up on mousedown/up); screenshot (canvas → PNG `"<deviceName> <date>.png"`); Capture keyboard (default on); UHID input (default off); quality stats; D-pad/Touch toggle; refresh stream (new demuxer, same URL); clipboard get / set.

**Stats overlay** (1 Hz on canvas, font scales with height): Resolution, Video codec, Encoder, Bitrate, Input bytes (+avg/s), Input FPS, Dropped FPS, Decoded FPS.

**Secure-context gate**: no `VideoDecoder` on `http://<lan-ip>` → no connect links; card and modal show notice naming loopback URL + Local HTTPS. Chromium flag does not help.

## A.4 Input

**Control messages (type byte)**: 0 keycode (14 B: action, keycode i32, repeat i32, meta i32), 1 text (unused), 2 touch (32 B: action, pointerId u64, x/y u32, w/h u16, pressure u16, actionButton u32, buttons u32), 3 scroll (21 B: x/y, w/h, hScroll/vScroll i16 fixed-point, buttons), 8 get clipboard (+copy_key u8: 0 none/1 copy/2 cut), 9 set clipboard (seq u64, paste u8, len u32, text), 10 screen power mode, 12/13/14 UHID create/input/destroy, 17 reset video; extensions 101 change stream params, 102 push file.

**Touch/mouse**: single document.body listener set shared across streams, filtered by target canvas. Letterbox-aware coordinate translation, bounds invalidation. Pointer-id map freed on release. Pressure from `touch.force` or 1.0/0. **Multi-touch simulation**: Ctrl+drag mirrors through canvas center; Ctrl+Shift mirrors through click point; green overlay markers. Touch-state validation injects synthetic UP/DOWN for stale/missing pointers; mouseleave releases all.

**Modes**: D-pad (default for TV/unknown): left-click → DPAD_CENTER; wheel → DPAD_UP/DOWN (fire-then-400 ms debounce), Shift+wheel → LEFT/RIGHT. Touch (default phone/tablet): wheel → scroll msg throttled 30 ms, `SCROLL_DIVISOR=128` (vs scrcpy's 16, deliberately slower). Both: right-click BACK, middle-click HOME.

**Keyboard (keycode path)**: `KeyboardEvent.code` → Android keycode map (letters, digits, punctuation, modifiers, nav, numpad, F1–F12, IME keys); repeat counter per key; meta bitmask from `getModifierState`; `preventDefault` on mapped keys.

**UHID**: on enable, creates keyboard (id 1, 63 B boot descriptor, 6-key rollover) and mouse (id 2, 5 buttons, rel int8 x/y/wheel), vendor/product 0, names `"ws-scrcpy keyboard"/"ws-scrcpy mouse"`; disables touch + keycode paths. Mouse uses Pointer Lock (click canvas); `movementX/Y` clamped ±127; zero report on lock loss. Detach sends all-zero report, destroys both.

**Clipboard**: get → injects `KEYCODE_COPY` on device (API 24+), text returns async via DEVICE_MSG. Set → `navigator.clipboard.readText()` → type 9 (paste=false). Device→host delivery: tries `writeText`; on rejection shows "Device clipboard ready — click to copy" prompt (30 s auto-hide) using sync `execCommand('copy')` fallback (works in iframes without clipboard-write). Generation counter prevents stale writes.

**Drag-and-drop push**: NEW → START (id, name, size) → APPEND chunks (strict one-in-flight backpressure) → FINISH; server accumulates to `os.tmpdir()/adb_push_<id>_<ts>` then `adb push` to `<currentDir>/<name>` (overwrites). 13 response codes. No type filtering.

## A.5 Device tools

**Shell**: xterm.js (defaults) + AttachAddon + FitAddon over a multiplexed channel `SHEL` on `?action=multiplex`. Messages `{id:1,type:'shell',data:{type:'start'|'resize'|'stop', rows, cols, udid}}`. Server: `node-pty` spawns `adb -s <udid> shell`, `TERM=xterm-256color`, env allowlist (PATH, HOME, USER, LANG, ANDROID_* …), output coalesced every 5 ms, exit → close 1000/4500. Modal `clamp(500px,90vw,1600px)`, resize warning banner, Escape/backdrop ignored, × → confirm if session started. Gated by `GET /api/capabilities {shell, shellReason}` with 3 tooltip variants; fails open.

**File browser**: channel `FSLS` (+serial) as sub-multiplexer; per-op sub-channels with `STAT|LIST|RECV|SEND` + u32LE len + path. STAT via `stat -c '%f %s %Y' || stat -c '%a %s %Y'`; missing → fallback `/data/local/tmp`. LIST via `ls -1a` + per-entry stat (fallback `ls -lad`), `DENT` frames, completion = channel close. RECV via `adb exec-out cat` (50 MB `maxBuffer` cap), 64 KB `DATA` frames + `DONE`, browser `<a download>`. Breadcrumbs (root + clickable segments), client-side name filter, sort name/size/date with dirs-first, ▲/▼ indicator. Icons: folder/image/video/audio/text/file by extension, 6 colors; icon-size picker 16/20/24/28/32 px, persisted per-user (`iconSize`, 0 = unset), reopen via header ⊞. Rows: checkbox, icon, name, reserved hover actions (↓ files only, × all), size (B/KB/MB/GB 1 dp), date `mon dd yy`. Header tri-state checkbox. Footer: delete (any selection), download (files only, one RECV each, no zip), upload (picker, multi), `"n selected / m items"`. Upload rows with %, error rows red 2 s then reload (debounced 500 ms). Delete = REST `POST /api/devices/files/delete {udid, paths[]}` → `rm -rf` each; ≤1000 paths, absolute, no `.`/`..`, protected roots (`/`, `/sdcard`, `/storage`, `/storage/emulated[/0]`, `/data`, `/system`, `/vendor`, `/mnt`, `/proc`, `/dev`); 200 / 207 partial / 400. Close with transfers → `confirm()`.

**Modal base class**: native `<dialog>`, overridable Escape/backdrop/×/`onBeforeClose`, `dismissible:false` mode, parent/child stacking with auto-close, `askChild` returns `unanswered` if parent closes first, `closeAfter(ms)`, `@starting-style` animation, opaque frame for nested modals.

## A.6 Device management

**Tracking**: `ControlCenter` polls `adb devices` every 5 s; diffs for connect/disconnect; property fetch with backoff (1.5 s doubling, 7 attempts); per-tick `checkScreenState` (`dumpsys power | grep mWakefulness`) and one-time `detectDeviceKind`; descriptor pushes throttled 300 ms over `action=goog-device-list` WS. Device records sighting under real serial, backfills MAC from ARP cache (host only).

**Device kind**: `ro.build.characteristics` contains `tv` or `pm has-feature android.software.leanback` → tv; else `min(w,h)/(density/160) ≥ 600` → tablet, else phone. Badge icon on card; seeds D-pad/Touch default.

**Card**: green/red left border by state; rows Device Name (inline edit: pencil, Enter save, Esc cancel, optimistic), Model (manufacturer-prefixed), Device ID, Android major, SDK. Actions: Disconnect (only if udid contains `:`), Sleep/Wake (`checking…`/`turn off`/`turn on`; `input keyevent 223/224`, 500 ms, re-read). Services grid: shell, list files, connect (per player, active only), configure stream. Insecure-origin notice when no players.

**Labels**: `device_labels(user_id, serial, label)` per-user; written under serial AND MAC alias; empty = delete; no length limit. Resolution precedence for scan hits: explicit → real serial → serial-seen-at-address → MAC → raw address. Pending-label map (10 min TTL) for devices whose serial isn't known yet. Editable on card and on scan result cards.

**Network discovery panel**: quick scan (mDNS only), scan network (modal), manually add (address, port default 5555, label). Scan WS `/ws-scan`: `scan.start {subnets[], mdnsOnly?}` / `scan.cancel`; server emits `started {totalHosts,totalSubnets,startedAt}`, `progress {checked,total,foundSoFar}` every 10 hosts, `hit {source, address, serial, name, label, model?, mayNeedPairing?}`, `draining`, `complete|cancelled {found}`, `error`. Late joiners get snapshot replay. One scan at a time; 256 KiB cap.

**Scan algorithm**: mDNS via `adb mdns services` (`_adb*` minus pairing); TCP sweep with worker pool default 64 (max 512, fd-budget clamped), 300 ms connect timeout, ADB CNXN handshake probe (CNXN → model from banner; AUTH → adb no model; STLS → needs pairing), 5 s handshake timeout, FIN+250 ms grace for confirmed ADB. Dedupe against connected devices (hostname-expanded) and across tracks. Pre-warm `adb start-server`. Cancel = drain, not abort; client disconnect doesn't cancel.

**Subnet input**: CIDR (/16–/32, /31 special), range `a.b.c.d-e` or full (≤65 536), bare IP (/32); must be entirely RFC1918 (SSRF guard, re-validated server-side); errors link to `help/subnets.html`. Gateway auto-detect: `ip route show default` lowest metric → `ip -o -4 addr` (fallback: largest RFC1918 interface). Container → `{container:true}` + note. User subnets persisted globally (`scanSubnets`). >2048 total hosts → warning modal with ~30 s/1000 hosts estimate. Modal shows IDS warning banner.

**Progress chip**: scanning (n/m · k found, cancel), draining, complete (auto-hide 5 s), cancelled (min 1.2 s shown, hide 10 s), connection lost/failed.

**QR pairing** (Android 11+): `POST /api/devices/pair/qr` → server-rendered SVG (Nayuki encoder, ECC M) of `WIFI:T:ADB;S:wsscrcpy-<10 base32>;P:<12 chars no I/l/1/O/0>;;`; secret never leaves server or logs. Poll `adb mdns services` 1 s for `_adb-tls-pairing._tcp` name match → `adb pair` → find `_adb-tls-connect._tcp` by guid/IP → `adb connect` → `ControlCenter.refreshNow()`. States `awaiting-scan → pairing → connecting → paired | paired-not-connected | failed | expired` (180 s scan window). Code mode: `POST /pair/code {address, code 4–10 digits}`. Status poll 1 s, 3 transport failures tolerated, client-side countdown. All routes admin-gated (not loopback-gated). Single session; new supersedes old.

**Connect/disconnect**: `POST /api/devices/connect {address, serial?, label?}` (ungated), `isConnectAddress` regex (host[:port], IPv6 brackets, ≤300 chars). Disconnect idempotent on "no such device".

## A.7 Home page & shell UI

- Single scrollable page: connected devices grid, network discovery, (dependency alert card). Responsive 1–5 columns, mobile→4K.
- Theme: sync first paint from `prefers-color-scheme`, then DB-stored per-user `theme`; toggle persists; `data-theme` attribute observer.
- Welcome modal (host, `firstRunComplete=false`): shows URL, "run as a service?" yes/no, Linux scope radio, "don't show again" (no-path only), bookmark + ~3 min first-download hints.
- Bookmark reminder (`bookmark`/`service` kinds): got it (per-port), never again (confirm, global), × (view only). Port change re-shows.
- First-run banner: polls `/api/dependencies` 15 s; non-deferred deps with `installedVersion=null` + Error/Unknown → "Setup incomplete — … failed to download" + Retry.
- Admin-scope banner: `local-actionable` (loopback: Set up sign-in / Allow remote admin w/ red confirm) vs `local-readonly` (instructions only); hidden under `authenticated`/`remote`; per-user dismiss.
- Update pill (30 s poll, 2 s while downloading); stale-token 403 → reload page; admin 403 → stop polling forever.
- Help pages: `help/subnets.html`, `help/certificate-subject.html` (per-OS CA install incl. Android/iOS/Firefox), themed via `?theme=`.
- No i18n (English only).

## A.8 Settings dialog

Tabbed: **Users, Embedding, Updates, Service, Dependencies, Server, Local HTTPS**; visibility by role/admin reachability; container replaces Service/Updates/Dependencies with fixed notes. **Staged** fields: `webPort`, `httpsPort`, `channel`, `autoUpdate`, `updateCheckIntervalMinutes` (5–1440), `githubOwner`, `frameAncestorsAdd`, `allowRemoteAdmin`. Single Save (disabled until dirty) → review modal listing `setting: old → new` (+ warnings: page reload / streams drop / lose admin access) → `POST /api/settings/batch` applied sequentially, stop at first refusal, partial commits by label. Close with unsaved → save/discard/cancel. Tab switch preserves edits. Status line per tab (success 5 s, error 10 s). Port change → restart → redirect after 4 s. Write-ahead log `pending_settings` survives port-change restart.

- **Users**: manage users modal (role select, disable, unlock, reset password w/ eye toggle, delete w/ last-admin 409), enable/disable login (409 if no admin password), remote-admin checkbox (warning modal on check; env-forced disables; notes per state).
- **Embedding**: list approved origins + revoke (confirm); add row (http/https/both scheme, host, port; both → 80/443; inline validation; no dupes; pending until Save).
- **Updates**: channel radios, auto-download checkbox, interval, GitHub owner (blur-commit); check/apply dual button with live status; dev-mode note.
- **Service**: scope radio (locks after install, `pointer-events:none` not `disabled`), system scope requires `/opt` install first; install (user scope no confirm) → handoff poll → navigate; uninstall → poll/relaunch; follow-up messages.
- **Dependencies**: table (name + paired badge, installed, latest, status, action), check for updates, install/update per row, restart prompt for Node.
- **Server**: HTTP/HTTPS ports (collision error, <1024 notice on linux/darwin, HTTPS disabled until cert+mkcert), reset my settings (wipes user settings/labels/device settings + first-run flags), change password, log out, stop server & exit (disabled in service mode), restart server, install for all users (Linux, greys when `/opt`), uninstall… (keep settings & logs option).
- **Local HTTPS**: see A.11.

## A.9 HTTP/WS API & security

**Stack**: hand-rolled `http(s)` + `ws`; ordered handler chain; `AuthGate` first; static/SPA fallback. 1 MiB body cap (413).

**Layers** (in order): Host allowlist (`localhost`, IP literals, `allowedHosts` domains; else 403 DNS-rebinding) → Origin must equal own origin on `/api/*` and non-GET (missing Origin allowed) → per-launch 256-bit `ws_scrcpy_token` HttpOnly cookie on document GETs, required on `/api/*` + all WS (exempt: `GET /api/config`, `GET /api/whoami`, `POST /api/server/shutdown`, `GET /api/tls/ca-root`, `GET /api/updates/status`) → `AuthGate` (locked mode) → `requireAdmin` / `requireOperator` (loopback, or locked+session, or open+`allowRemoteAdmin`) → container refusals (409).

**Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `CSP frame-ancestors 'self' <origins>` when configured. Cookies `SameSite=Strict` (token) / `Lax` (session) → `None; Secure; Partitioned` when `frameAncestors` non-empty **and** HTTPS (`X-Forwarded-Proto` trusted only from loopback peer).

**Auth**: open mode = implicit admin id 1. Locked: `wsscrcpy_sid` 30-day sliding, SHA-256 hashed in DB; scrypt N=16384 r=8 p=1; blind verify vs enumeration; lockout 5 fails/5 min → 15 min. Roles `user|admin`; last-enabled-admin guard; first user creation = atomic "lockdown" (rename implicit admin, set password, create user, enable). Logout/disable revokes live WS (4401). Allowlisted under lockdown: login, me, whoami, shutdown, embed-request.

**Routes** (auth): auth login/logout/me/change-password/enable/disable; users CRUD (operator); whoami (loopback); capabilities; config GET (public) / PATCH (operator; `restartRequired`, `redirectPort`); dependencies list/check/update/restart/retry-install; devices scan, scan/subnet, connect, disconnect, screen-state, sleep-wake, labels GET/PUT, files/delete, pair qr/code/status/cancel (admin); tls state/ca-root (rate-limited 10/60 s)/generate/revoke/exposure/https-port; service status/install/uninstall/install-system-wide/decline-system-wide/uninstall-app; settings GET/PATCH, device GET/PATCH (503+Retry-After until serial known), reset, batch; server shutdown (token-then-session ladder, exits 100 ms) / restart (`.restart` marker, exit 75); updates status/check/apply/config; embed-request POST/GET/cancel (loopback, outside `/api`), `/api/embed-request` GET + decision, `/api/embed-origins` GET + revoke (admin+loopback).

**WS**: handshake gate (Host/Origin + token, no exemptions); path `/ws-scan`; actions `list-hosts, goog-device-list, multiplex, shell, stream, list-files, probe`; multiplexer sub-channels with 4-byte codes.

**Plain-HTTP exposure** (`httpExposure`): `open` | `httpsOnly` (421) | `redirect` (302 to https, no-store); loopback always exempt; corrupt value → serve.

## A.10 Persistence & config

**SQLite** `wsscrcpy.db` (`node:sqlite`, `PRAGMA user_version`, 3 migrations, backup on shutdown, corrupt-store recovery from backup): `users`, `sessions`, `user_settings(user_id,key,value JSON)`, `devices(serial, manufacturer, model, address, last_seen_at, mac)`, `device_labels`, `device_settings(user_id,udid,scope,value)`, `app_settings(key,value)` (seeded `authEnabled=false`), `pending_settings` WAL.

**config.json** (boot file): `webPort` 8000, `httpsPort` 8443, `installMode`, `firstRunComplete`, `allowRemoteAdmin`, `allowedHosts[]`, `frameAncestors[]`, `adbPath`, `dependenciesPath`, `scanConcurrency`, `scanTcpTimeoutMs` 300, `scanAdbConnectTimeoutMs` 5000, `scanProgressInterval` 10, `server[]` advanced listeners. DB-stored once set: `autoUpdate` true, `updateCheckIntervalMinutes` 60, `channel`, `githubOwner`, `adbPath`, `dependenciesPath`, scan tunables, `theme`, `iconSize`, `scanSubnets`, `httpExposure`, prompt flags. Precedence env → DB → file → default.

**Port auto-shift**: walk `webPort..+99`; sibling instance (via `/api/whoami`) → use but don't persist; other holder → persist + `portWasAutoShifted`; `WS_SCRCPY_WEB_PORT` forces exact (ignored by system service); HTTP wins HTTPS collision.

**Env**: `WS_SCRCPY_CONFIG`, `WS_SCRCPY_PATHNAME`, `DEPS_PATH`, `DATA_ROOT`, `WS_SCRCPY_WEB_PORT`, `WS_SCRCPY_DOCKER`, `WS_SCRCPY_ALLOW_REMOTE_ADMIN`, `WS_SCRCPY_NO_BROWSER`, `WS_SCRCPY_OPEN_BROWSER`, `WS_SCRCPY_LAUNCHER`, `WS_SCRCPY_SERVICE`, `SCAN_CONCURRENCY`, `WS_SCRCPY_NODE_DIST_BASE`, `WS_SCRCPY_MKCERT_URL_BASE`, `WS_SCRCPY_RELEASE_URL_BASE`, `WS_SCRCPY_SKIP_BOOT_LATEST`, `VELOPACK_FEED_URL`, `APPIMAGE`.

**Logging**: `<ISO> [Tag] [WARN|ERROR] msg`; `appendFileSync`; console only on TTY; 10 MiB rotate to `.1`; `uncaughtException`/`unhandledRejection` handlers. Files: `ws-scrcpy-web.log`, `launcher.log`, `server.log` (crash catcher), `service.log` (copy-truncate).

## A.11 Local HTTPS

Vendored `mkcert` (fork, fetched on first use, Sigstore build-provenance verified against fork's release workflow + SHA-256 manifest). Subject = IP (combobox of RFC1918 addresses) or hostname (public-suffix refused). Generate: deletes old CA first, `chmod 0700` CAROOT, `TRUST_STORES=none`, `-name-constraints` for both IP and DNS, port suffix rejected, timeout. Cert at `<dataRoot>/tls/{ca,cert.pem,key.pem}`. HTTPS listener on `httpsPort` beside HTTP. CA download `ws-scrcpy-web-local-ca.crt` (works from other machines). Revoke. Notices: subject no longer a local address, expiry <30 days, listener state (restart-required / config-override / port-collision / bind-failed / stale leaf). Exposure modes take effect immediately. Off in containers.

## A.12 Dependency manager

| Dep | Source | Verify | Restart |
|---|---|---|---|
| Node.js (+node-pty prebuilt) | nodejs.org `index.json` LTS, filtered by node-pty ABI manifest | `SHASUMS256.txt` + OpenPGP sig vs pinned keys | yes (exit 75) |
| ADB platform-tools | Google `repository2-3.xml` | size + SHA-1 from XML | no (adb server bounced) |
| scrcpy-server | GitHub releases; bundled fallback on *refused* lookup | `SHA256SUMS.txt` + `.asc` vs pinned keys | no |
| mkcert | fork releases latest | Sigstore attestation + SHA-256 | no; `deferInstall` |

Boot `checkAll`, `autoInstallMissing` (non-deferred), seed `scrcpy-server` copied from `seed/`, PATH never consulted, absolute paths only. Statuses: Unknown/Checking/NotInstalled/UpToDate/UpdateAvailable/Error. Coalesced concurrent updates; `0700` scratch dirs. Container drops host-only deps (node, mkcert). node-pty: resolution chain seed → download prebuilt → load; weekly prebuild workflow; glibc/musl detection; `/api/capabilities`.

## A.13 App updater (Linux)

Velopack `UpdateManager` for check (GitHub releases resolver, ETag cached, 60 s timeout, 120 s download stall); channels `stable`/`beta` (beta feed also lists stable; version compare so stable 0.1.30 never offered 0.1.30-beta.N); `autoUpdate` gates download only. **Linux apply bypasses Velopack**: download `WsScrcpyWeb-linux-<channel>.AppImage` + `SHA256SUMS`, verify by basename, hand off to out-of-mount helper (`--linux-apply`): local → wait pid, swap with `.bak` self-heal, relaunch (`WS_SCRCPY_NO_BROWSER=1`); service → stop unit, swap, re-label `bin_t`, strip legacy port pin, start. Client `UpgradingOverlay` (applying/reconnecting/timeout), lost-apply watch tolerates proxy 502/503/504.

## A.14 Linux launcher, service, tray

**Launcher** (Rust): flags `--no-log`, `--unzip`, `--linux-apply`, `--linux-service-teardown`, `--linux-service-install-handoff`, `--linux-app-uninstall[-elevated]`, `--install-system-service`/`--uninstall-system-service [--keep-state]`/`--system-service-status` (foreground node, exit code propagated), `--operation-server`, `--local-takeover`. Data root: `DATA_ROOT` → `$XDG_DATA_HOME/WsScrcpyWeb` → `~/.local/share/WsScrcpyWeb` (panic if none). Deps `<dataRoot>/dependencies`. Node from deps or `seed/`, never PATH; `RLIMIT_NOFILE` → 4096. Supervisor: `.restart` marker beats exit code; 75 = restart; crash restart ≤3 (reset after 60 s up, 2 s delay); service mode leaves crashes to systemd; 10 s graceful SIGTERM; browser opened only on first spawn. Single instance via `flock` on `$XDG_RUNTIME_DIR/ws-scrcpy-web.lock` (else `<dataRoot>/control/instance.lock`); duplicate → `xdg-open` existing URL, exit 0. Root-trust guard (euid 0): wipes `dependencies/` if any entry non-root-owned/group-writable/symlink-escape; repairs `/opt` AppImage with fresh root copy (never chown). Operation-server: binds port (10 s retry, +10 port probe), serves "Updating…/Uninstalling…" page, 503 on `/api`, stop marker 200 ms poll, 30 s max life, port-shift redirect JSON, 64 inflight cap.

**systemd**: user unit `~/.config/systemd/user/WsScrcpyWeb.service` (ExecStart = `/opt` copy or `<dataRoot>/bin/WsScrcpyWeb.AppImage`, `Restart=on-failure` 5 s, `default.target`, `loginctl enable-linger` best-effort); system unit `/etc/systemd/system/` (`DATA_ROOT=/var/lib/ws-scrcpy-web`, `WS_SCRCPY_SERVICE=1`, `RestartSec=2s` for port takeover, `StartLimit 10/60s`, `multi-user.target`). Install: `pkexec` (desktop) or `sudo` (headless), stage `/opt/ws-scrcpy-web/` with `install -o root -m 0755`, `semanage fcontext bin_t` + `restorecon`, empty root-owned `dependencies/`, `umask 022`, verify active + TCP up to 120 s. User-scope handoff helper (port dead ≤20 s → start → is-active+TCP ≤12 s → rollback on failure). Teardown via `systemd-run --collect` transient unit: stop/disable/reset-failed/rm unit/(system: rm `/opt`, `/var/lib`, semanage -d)/daemon-reload/`adb kill-server`/(user: relaunch local). Full uninstall: single `pkexec` max; `--keep` deletes only `dependencies/ bin/ control/`; removes `.desktop`, icon, lock, strays via `/proc` walk (`WsScrcpyWeb`, `ws-scrcpy-web-launcher`, `scrcpy-server`, legacy tray); validated `--data-root`.

**Tray**: `ksni` StatusNotifierItem thread in launcher; eligible when not system-service and session bus present; 22×22 ARGB icon; tooltip `ws-scrcpy-web` / `(service)`; menu Open (`xdg-open`, re-reads port) and Exit → stop & quit (SIGTERM to Node); silent stand-down without host (GNOME).

**AppImage**: Velopack-built, static type-2 runtime (no libfuse2), works under Ubuntu userns restriction, glibc ≥2.31, unsigned (SHA256SUMS + Sigstore provenance), stable/beta channel files.

## A.15 Docker

Image `node:24-trixie-slim` by digest, two-stage, prod deps from lockfile, npm/corepack removed, `tini -g`, `setpriv` drop to uid 1000 after conditional `chown /data`, custom uid supported with remediation message, `HOME=/data/home` (adb keys persist). Env `DATA_ROOT=/data`, `DEPS_PATH=/data/dependencies`, `WS_SCRCPY_DOCKER=1`, `WS_SCRCPY_WEB_PORT=8000`. `VOLUME /data`, `EXPOSE 8000`, healthcheck `/api/config` (15 s/5 s/180 s start/5). `start.sh` restart loop (marker/75, signal forward). Compose: `127.0.0.1:8123:8000`, `wsdata` volume, `WS_SCRCPY_ALLOW_REMOTE_ADMIN` passthrough. Wireless ADB only; scan needs manual LAN subnet (mDNS/QR need `--network host`); Local HTTPS off (reverse proxy recipe: forward Host, Upgrade, `X-Forwarded-Proto`, `allowedHosts`). Publish: Docker Hub + GHCR, `linux/amd64`, Scout gate fails on fixable critical/high, tags version + `beta` | `latest`+`stable`, SBOM + provenance.

## A.16 Public API & embedding

`WsScrcpy.startStream(container, deviceId, options)` (UMD `ws-scrcpy.umd.js` global `WsScrcpy`, ESM `ws-scrcpy.esm.js`, `ws-scrcpy.css`, `ws-scrcpy.d.ts`). Options: `host, port, secure, pathname, codec, encoder, bitrate(8M), maxFps(15), maxSize(0), audio, audioSource, audioCodec, keyboard(true), deviceKind, onConnect({codec,encoder,resolution}), onDisconnect(reason), onError(err)`; fit-to-screen forced; exactly one of disconnect/error per end; handle `{stop(), isConnected, deviceId}`, idempotent stop, `data-ws-scrcpy-active` marker. Also exports `getTheme, setTheme, installThemeEmbedListener, notifyThemeReady, notifyThemeChanged`.

`/embed.html?device=…` + `host, port, pathname, codec, encoder, deviceKind, audioSource, audioCodec, bitrate, maxFps, maxSize, secure, audio, keyboard`; transparent body; status overlay (connecting / connected·codec·res 2 s / disconnected / error).

Theme bridge `postMessage` types `ws-scrcpy-web:theme-ready|theme-changed|theme|theme-request`, `allowedOrigins` `'*'|string[]|fn`.

Embed consent: native app POSTs `/embed-request {origin, appName}` from loopback (5 min TTL, one pending, IPv6 refused, appName ≤64), polls `/embed-request/:id`, may cancel; app shows non-dismissible modal (origin verbatim, countdown, withdrawal poll 3 s) → approve persists to `frameAncestors` + CSP. Origin rules: http(s), no path, no `*`, host `[a-z0-9.-]`.

## A.17 Not present (gaps a competitor could fill)

i18n; screen recording; logcat; multi-display enumeration (dropdown has one entry); recursive directory download / zip; arm64 Docker image; signed AppImage; Safari/Firefox (WebCodecs); USB passthrough in container; macOS launcher/tray (server runs anywhere Node does, but installer/service/tray are Linux-only).

---

# Part B — Full subsystem detail (code-level)

Each section below is the complete investigation record for that subsystem, with file paths and line references. Headings are nested under B.N.


## B.1 Streaming pipeline


#### Scope
Covers the end-to-end video/audio mirroring pipeline: scrcpy-server launch, WebSocket multiplexing wire protocol, codec negotiation/fallback, client-side `VideoSettings`, display selection, decode-watchdog/keyframe recovery, rotation handling, stats overlay, toolbar, stream-modal lifecycle, screenshot, fit-to-screen, secure-context gating, and error/reconnect states. Windows-only code is excluded.

---

### 1. Session start sequence (server)

File: `src/server/ScrcpyConnection.ts`

1. `processRequest` (`:88`) handles `action=stream`, requires `udid` query param (else WS close `4003`); refuses new sessions with `SHUTDOWN_CLOSE_CODE`/`SHUTDOWN_CLOSE_REASON` if the server is shutting down (`liveStreams.isStopping()`).
2. `buildOptions()` (`:140`) generates a random 8-hex-char `scid` and calls `scrcpyOptionsFromQuery(queryParams, scid)`.
3. `start()` (`:146`):
   - Reads device SDK (`getSdkInt`, prefers `ControlCenter`'s cached `ro.build.version.sdk`, else one `adb shell getprop ro.build.version.sdk`) and the device's audio-encoder list (`listAudioEncoders`, via `dumpsys media.player`, skipped entirely if `options.audio === false`) **in parallel**.
   - **SDK gates:**
     - `sdkInt > 0 && sdkInt < 28` → `tunnelForward=true`, `cleanup=false` (reverse-over-TCP unreliable pre-Android-9; JAR self-delete races ART class loading).
     - `sdkInt > 0 && sdkInt < 30` → forces `audio=false` (scrcpy can't capture audio before Android 11).
     - `sdkInt > 0 && sdkInt < 33` and `audioSource === 'playback'` → forces `audio=false` (`--audio-dup` needs Android 13+; silently keeping `playback` would silence the device with no `--audio-dup`).
   - **Audio-codec fallback** (if `audio !== false`): `chooseAudioCodec(requestedCodec, audioEncoders)` — see §4.
   - Logs both the literal arg list (`serializeOptions`) and the "effective" config (`describeEffectiveOptions`), each line independently diffable against desktop scrcpy.
   - Pushes `scrcpy-server` to the device only if missing/different size (`ensureScrcpyServerPushed`).
   - Opens tunnel + launches server + collects 3 TCP sockets (video, audio, control) — §2.
   - Parses the opening metadata packet (§3), overrides `metadata.videoEncoder` with the client-requested one if set.
   - Sends `ChannelId.METADATA` JSON to the browser, then starts forwarding (§5).
   - Arms an 8 s one-shot stall timer (`STALL_AFTER_MS`): if no decodable video has registered, logs a diagnostic line and calls `requestKeyframeIfConfigMissing(1)`.

#### 1.1 scrcpy-server launch command
```
CLASSPATH=<DEVICE_SERVER_PATH> app_process / <SERVER_PACKAGE> <installedVersion> <args...>
```
`args` = `serializeOptions(options)` — only values that differ from scrcpy defaults, plus always `scid=<hex>`, plus `video_encoder=<name>` and `video_codec_options=<csv>` if set (`src/server/ScrcpyOptions.ts:77-91`). Server stdout/stderr are tee'd into the app log. On process `exit`, the session is ended as a failure (`releaseAsFailure`) unless already released.

#### 1.2 ScrcpyOptions fields & defaults (`src/server/ScrcpyOptions.ts:2-40`)

| field | type | default | notes |
|---|---|---|---|
| `scid` | string (8 hex) | required | always emitted |
| `videoCodec` | h264\|h265\|av1\|vp8\|vp9 | h264 | |
| `audioCodec` | opus\|aac\|flac\|raw | opus | |
| `audioSource` | output\|playback\|mic | output | |
| `audioDup` | bool | false | auto-set `true` when `audioSource==='playback'` (`scrcpyOptionsFromQuery.ts:43`) |
| `maxSize` | int | 0 (unbounded) | |
| `videoBitRate` | int | 8000000 | |
| `maxFps` | int | 0 (unbounded) | |
| `audio` | bool | true | |
| `control` | bool | true | not client-configurable via query |
| `displayId` | int | 0 | |
| `sendDeviceMeta`/`sendCodecMeta`/`sendFrameMeta` | bool | true | not client-configurable |
| `tunnelForward` | bool | false | server-decided (SDK<28) |
| `cleanup` | bool | true | server-decided (SDK<28 → false) |
| `videoEncoder` | string | device default | allowlisted free-form string (`ENCODER_RE` `^[A-Za-z0-9_.-]{1,128}$`) |
| `videoCodecOptions` | string | none | `key[:type]=value,...`, allowlisted (`CODEC_OPTIONS_RE` `^[A-Za-z0-9_.:,=-]{1,256}$`) |

Query params parsed by `scrcpyOptionsFromQuery` (`src/server/scrcpyOptionsFromQuery.ts`): `maxSize`, `bitrate`→`videoBitRate`, `maxFps`, `displayId`, `videoCodec`, `audioCodec`, `audio` (`'true'|'false'` string literal), `audioSource`, `videoEncoder`, `videoCodecOptions`. Unsafe/unrecognized values are silently dropped (not errored).

---

### 2. Tunnel setup — two paths

#### 2.1 Reverse tunnel (default, SDK ≥ 28) — `startWithReverseTunnel` (`ScrcpyConnection.ts:~373`)
- Host opens an ephemeral TCP listener; `adb reverse localabstract:scrcpy_<scid> tcp:<port>`.
- Launches server; server connects out. Expected connection count = `expectedTunnelSocketCount(audioEnabled)` → 3 if audio, 2 otherwise (10 s accept timeout; error message literally: `Timeout waiting for N TCP connections (got M)`).
- `assembleReverseTunnelSockets` (`src/server/scrcpyTunnelSockets.ts`) splices a synthetic `createAudioDisabledSocket()` (4-byte `AUDIO_DISABLED=0x0` status) into slot 1 when audio is off, so downstream code has a uniform `[video, audio, control]` triple.

#### 2.2 Forward tunnel (SDK < 28) — `startWithForwardTunnel`
- Host reserves a local port, `adb forward tcp:<port> localabstract:scrcpy_<scid>`; launches server; host dials in.
- Readiness is NOT "TCP connect succeeded" (adb-forward accepts eagerly before device binds) — it waits up to **120 s** for scrcpy's dummy `0x00` handshake byte on the first socket, retrying the connect every ~150 ms on timeout (`connectAndAwaitDummy`).
- Connects remaining sockets in order video → (audio, 100 ms gap, only if enabled) → control, each with a 15 s connect timeout.

---

### 3. Opening metadata packet (video socket, 80 bytes) — `ScrcpyConnection.parseMetadata`

scrcpy v4 layout (12-byte "session packet" wrapper, differs from pre-v4's bare 76-byte layout):

| offset | bytes | field |
|---|---|---|
| 0–63 | 64 | device name, null-padded UTF-8 |
| 64–67 | 4 | video codec ID (BE u32) |
| 68–71 | 4 | session-packet flags — MSB `0x80000000` **must** be set or the connection throws `scrcpy stream metadata: expected session-packet flag MSB...` |
| 72–75 | 4 | video width (BE u32) |
| 76–79 | 4 | video height (BE u32) |

Audio socket: 4-byte codec ID or status (`AUDIO_DISABLED=0x00000000`, `AUDIO_ERROR=0x00000001`).

Codec IDs (`src/common/ScrcpyCodec.ts`): `H264=0x68323634`, `H265=0x68323635`, `AV1=0x00617631`, `VP8=0x00767038`, `VP9=0x00767039`, `OPUS=0x6f707573`, `AAC=0x00616163`, `FLAC=0x666c6163`, `RAW=0x00726177`. Unknown IDs render as `unknown(0x<hex>)`.

`SessionMetadata` sent to browser as JSON on `ChannelId.METADATA`: `{ deviceName, videoCodec, screenWidth, screenHeight, audioCodec, videoEncoder? }`. `audioCodec` may literally be the strings `'disabled'` or `'error'`.

---

### 4. Audio codec fallback — `src/server/audioCodecFallback.ts`

`chooseAudioCodec(requested, availableEncoderNames)`:
- `requested === 'raw'` → never touched (needs no encoder).
- `availableEncoderNames` empty → **unknown, not none**; leaves config unchanged (devices' `dumpsys media.player` doesn't always report encoders).
- Encoder match is a dotted-segment test, e.g. `.opus.` in `c2.android.opus.encoder` (case-insensitive).
- If requested codec unsupported, falls back through `FALLBACK_ORDER = ['aac', 'opus', 'flac']` (skipping the requested one).
- If nothing matches, `disable: true` — **audio is turned off entirely rather than killing video** (a codec the device can't encode crashes `MediaCodec` → kills the whole scrcpy-server process, including video).
- Every decision logs a one-sentence `reason`, every session, even the no-op case.

---

### 5. Media forwarding & wire framing (server → browser)

#### 5.1 `FrameReader` (`src/server/FrameReader.ts`) — TCP byte stream → frames
scrcpy v4 constants: `PACKET_FLAG_SESSION = 1<<63`, `PTS_FLAG_CONFIG = 1<<62`, `PTS_FLAG_KEYFRAME = 1<<61`, `PTS_CLEAR_FLAGS` masks the low 61 bits.
- 12-byte header: first 8 bytes are either (a) a mid-stream **session packet** (MSB set) = 4-byte flags + 4-byte width + 4-byte height, no body — fired via `onSessionChange`; or (b) a **media packet** = PTS+flags (8B) + size (4B BE), followed by `size` bytes of payload.
- `type` = `'config'` | `'keyframe'` | `'frame'`.

#### 5.2 Channel-multiplexed WS frame (server → browser), per message
```
[1 byte channel id][payload]
```
For VIDEO/AUDIO payload: `[8 bytes PTS+flags BE][4 bytes length BE][data]` — `ScrcpyConnection.sendChannel` re-sets `PTS_FLAG_CONFIG`/`PTS_FLAG_KEYFRAME` into the PTS word before emitting. `ChannelId` enum (`src/common/ChannelId.ts`): `VIDEO=0, AUDIO=1, CONTROL=2, DEVICE_MSG=3, METADATA=4, SESSION=5`. METADATA/SESSION payload is UTF-8 JSON. DEVICE_MSG is raw forwarded control-socket bytes (framed client-side by `DeviceMessageFramer`, TCP-chunk reassembly).

Browser → server: `[1 byte channel=CONTROL(2)][payload]`; server writes payload verbatim to the control socket if present and not destroyed; messages <2 bytes are dropped.

If `ws.readyState !== OPEN` when sending, the frame is silently dropped but counted/logged once (`StreamDiagnostics.noteDropped`).

#### 5.3 Client-side demuxing — `src/app/ScrcpyDemuxer.ts`
Mirrors the server framing exactly (same flag bit positions, `FRAME_HEADER_SIZE=12`). Exposes callbacks: `onVideoFrame(data,pts,isConfig,isKeyframe)`, `onAudioFrame`, `onDeviceMessage`, `onMetadata`, `onSessionChange`, `onDisconnect`. `sendControl` queues messages while `CONNECTING` and flushes on `open`.

---

### 6. Server-side congestion / backlog shedding — `src/server/StreamCongestion.ts`

Pure state machine, keyed off `ws.bufferedAmount` per packet, states: `flowing → congested → awaiting-keyframe → flowing`.
- **High water** = 4 MiB (`DEFAULT_HIGH_WATER`, ~4 s of 8 Mbps video) triggers `congested`.
- **Low water** = 1 MiB (`DEFAULT_LOW_WATER`) — must drop back below this to leave `congested` (hysteresis prevents flapping).
- While `congested`: video deltas and audio are **shed** (dropped, never sent); config packets are **never** shed.
- On drain (`congested`→`awaiting-keyframe`): one `TYPE_RESET_VIDEO` control byte (`CONTROL_MSG_RESET_VIDEO=17`) is sent to the device if a control socket exists, else the session waits for the device's own periodic keyframe (scrcpy default interval 10 s).
- While `awaiting-keyframe`: delta frames keep being dropped and counted (`deltasSkipped`) until a `keyframe` packet arrives, at which point state returns to `flowing` and a `resumed` event is logged.
- Log lines (not part of the parsed "stream summary" line used by test harnesses): `congested` (bufferedAmount), `drained` (afterMs, videoShed, audioShed, peakBufferedAmount), `resumed` (waitedMs, deltasSkipped).

---

### 7. Server-side keyframe recovery for missing config — `ScrcpyConnection.requestKeyframeIfConfigMissing`

- Triggered once by the stall timer (8 s after session start) if no config packet has been counted yet (`diagnostics.canRecoverWithKeyframeRequest()`).
- Writes `TYPE_RESET_VIDEO` (byte `17`, no payload) to the control socket.
- Retries up to `KEYFRAME_REQUEST_ATTEMPTS = 3` times, `KEYFRAME_RETRY_MS = 2000` apart.
- If the control socket doesn't exist (`control=false`), logs once and stops — not treated as a fault.
- After exhausting attempts, logs that the device is "not producing one for this session" and gives up (no infinite retry — avoids hammering a struggling device).

---

### 8. Session end / close codes

- **Normal end**: server-side `release()` closes with no code (browser sees 1005) — this is the "clean" path.
- **Session failed** (`SESSION_FAILED_CLOSE_CODE = 4005`): scrcpy-server exited, device stopped sending video, a start-time error, etc. Reason text goes in the close frame (`closeReason(...)`, capped — see `MAX_CLOSE_REASON_BYTES` in `src/common/closeReason.ts`).
- **Server shutdown**: `SHUTDOWN_CLOSE_CODE = 1001` with `SHUTDOWN_CLOSE_REASON` — browser treats this as a normal end (prevents `adb kill-server`'s SIGTERM from being misreported as a session failure).
- **Multiplexer protocol errors**: `4002` unsupported request, `4005` failed-to-start service.
- **Probe errors** (`DeviceProbe`): `4003` missing `udid`, `4005` probe failure, `1000` normal probe completion.
- Client-side classification (`src/app/googDevice/client/StreamClientScrcpy.ts:streamFailureFromClose`): `NORMAL_CLOSE_CODES = {1000, 1001, 1005}`; anything else (including `1006` — dropped without a close frame) is surfaced via `onErrorReceived` as `Error(ev.reason || "WebSocket closed with code <code>")`.
- A stuck `CLOSING` WebSocket (peer sent FIN, no close frame, send buffer won't drain) is force-terminated by `watchForStuckClosing` after a grace period so the device/session isn't held open indefinitely (was previously ~4 minutes).

---

### 9. Client-side codec selection — `src/app/googDevice/client/codecSelection.ts`

- `CODEC_ENCODER_PATTERNS`: substrings per codec in an Android encoder name — `h264: ['.avc.', '.h264.']`, `h265: ['.hevc.', '.h265.']`, `av1: ['.av1.']`, `vp8: ['.vp8.']`, `vp9: ['.vp9.']`.
- `CODEC_PREFERENCE = ['h265', 'h264', 'av1', 'vp8', 'vp9']`; `FALLBACK_CODEC = 'h264'`.
- `isSoftwareEncoder`: matches `c2.android.*` or `OMX.google.*` (inverted allowlist — any non-matching name is treated as vendor silicon, safer than an allowlist of known vendors).
- `pickEncoderForCodec`: prefers a hardware match, falls back to the first matching software one.
- `chooseCodec(videoEncoders, canDecode, log)`: walks `CODEC_PREFERENCE`, skips codecs the device can't encode, skips ones the browser can't decode (`canDecode`), returns the first codec+encoder pair both sides support; falls through to bare `h264` if nothing matches.
- `chooseCodecWithoutProbe(canDecode, log)`: same preference order with browser support alone (used when the device probe itself fails).

Automatic detection (`src/app/googDevice/client/StreamClientScrcpy.ts: detectBestCodecAndEncoder`) runs only when no explicit `videoCodec` param is supplied (i.e. a direct deep link bypassing the Configure modal); it probes the device via `DeviceProbeClient`, then calls `chooseCodec`.

If a caller/URL explicitly supplies a `videoCodec` that the browser cannot decode, `StreamClientScrcpy.startStream` silently rewrites it to `h264` and clears any explicit `encoderName` (`:~557-565`).

#### 9.1 Decode-support probing — `src/app/player/webCodecsConfig.ts`
- `CODEC_PROBE_STRINGS`: h264 tries 3 profile strings (`avc1.42E01E`, `avc1.4D401E`, `avc1.640028`) because Firefox under-reports a single profile; h265 `hev1.1.6.L93.B0`; av1 `av01.0.04M.08`; vp8 `vp8`; vp9 `vp09.00.10.08`.
- `probeDecodeSupport(codec)`: returns `true`/`false` from `VideoDecoder.isConfigSupported()`, or `undefined` if WebCodecs is absent or every candidate threw (an "unanswerable" probe, distinct from a real `false`). A definite `false` must never be overridden — this closed issue #498 where h264 was blindly assumed supported.
- `CONFIGLESS_CODECS = ['vp8', 'vp9']`: configured from session metadata rather than a parsed config packet (their 12-byte `BUFFER_FLAG_CODEC_CONFIG` packet carries no usable SPS/PPS-equivalent).

---

### 10. Device probe endpoint (feeds the Configure modal) — `src/server/DeviceProbe.ts`

`action=probe-device&udid=<udid>` WS, one-shot. Response JSON (`ProbeResult`): `{ width, height, density, sdkInt, videoEncoders: string[], audioEncoders: string[] }`.
- `width`/`height`/`density` from `adb shell wm size` / `wm density`.
- Encoder lists: via `dumpsys media.player` (regex `Encoder "([^"]+)" supports`, bucketed into video/audio by substring match against `['avc','h264','hevc','h265','av1','vp8','vp9']` / `['opus','aac','flac']`), **or**, for SDK<28 devices (dumpsys doesn't reliably report there, and can take 60s+ on old hardware), via scrcpy-server's own `list_encoders=true` run (`cleanup=false` so the dexopt cache stays warm for the following stream). `parseScrcpyEncoderList` (`src/server/scrcpyEncoderList.ts`) regex-extracts `--video-encoder=(\S+)` / `--audio-encoder=(\S+)` tokens, ignoring trailing `(hw)/(sw)/[vendor]/(alias for X)` annotations.
- Close codes: `4003` missing udid, `4005` probe error, `1000` success.

---

### 11. Configure-stream modal — `src/app/googDevice/client/ConfigureScrcpy.ts`

Opened from the device list ("config stream" button). Async lifecycle: `init()` hydrates per-device settings cache (`settingsService.hydrateDevice`), loads `AudioSettingsStore`, calls `populateUI()` then `runProbe()`.

#### 11.1 Fields (basic section)
- **display** dropdown — populated post-probe with a single entry `ID: <id>; <width>x<height>` (`DisplayInfo.DEFAULT_DISPLAY=0`); multi-display is not actually enumerable today (only 1 option ever appears).
- **video codec** dropdown — built from `detectVideoCodecs(probe.videoEncoders)` filtered through `filterSupportedCodecs` (drops a codec only on a definite browser `false`, keeps it on an "unanswerable" probe). Default preference after load: H.265 if offered and current selection is still the bare default `h264`.
- **encoder** dropdown — filtered to the selected codec by `encoderMatchesCodec`; first option is always blank (`''` = device default/auto); defaults to a hardware HEVC pick matching `/\.mtk\.hevc\.|\.qcom\.hevc\.|\.exynos\.hevc\./i` when nothing is stored.
- **max fps** — range slider, min 1, max 60, step 1.
- **audio codec** dropdown — from `detectAudioCodecs(probe.audioEncoders)`: includes `opus`/`aac`/`flac` if the corresponding `.codec.` substring is found, **always** includes `raw`.
- **audio source** dropdown — `output` (default, always shown, "silences device during session"), `playback` (shown only if `audioDupSupported(sdkInt)` i.e. SDK≥33, "keeps device audio"), `mic` (always shown, "captures device microphone").
- **enable audio** checkbox — disabled entirely if `!audioCaptureSupported(sdkInt)` (SDK<30), with tooltip "Android 11+ required for audio capture (device SDK too old)"; default from `AudioSettingsStore` or `audioEnabledDefault(deviceKind)` (always `true` today, kind unused).
- **bitrate** — range slider, min 524288 (512 KiB), max 8388608 (8 MiB), step 524288, formatted via `Util.prettyBytes`. Covers video+audio+control combined.

#### 11.2 Advanced section (collapsed by default, toggled by chevron button)
- **i-frame interval** — plain numeric input, seconds between keyframes requested. ⚠️ Documented as **not reliably honored** by Android encoders (verified: measured keyframe spacing ~14 s regardless of 2 vs default on a Pixel 10a; upstream scrcpy issues 3260/4857) — sent anyway so the UI doesn't silently discard a value the user entered.
- **fit to screen** checkbox — when checked, disables and blanks the max-width/max-height inputs (values stashed on a DOM attribute and restored if unchecked).
- **max width** / **max height** — numeric inputs; combined into a `Size` bound.
- **codec options** — free-form text, allowlisted server-side (`CODEC_OPTIONS_RE`). If the user's string already sets `i-frame-interval:`, the slider's value is **not** duplicated (`buildVideoCodecOptions`, user wins).

#### 11.3 Settings row buttons
- **reset** — reloads inputs from `player.getPreferredVideoSetting()` (the player class's hardcoded defaults), does not touch fit-to-screen.
- **load** — re-reads stored-or-preferred settings for this device/display (`updateVideoSettingsForPlayer`).
- **save** — persists `VideoSettings` (video group) via `player.saveVideoSettings` and the audio group (`enabled`/`source`/`codec`) via `AudioSettingsStore.save`; button text flips to "saved" for 1.5 s.

#### 11.4 Status line states
`setStatus`/`updateStatus` set CSS class by prefix: `status-probing` (text starts with "probing"), `status-ready` (exactly `"ready"`), `status-error` (explicit error kind or text starts with "probe failed"). After a successful probe, `statusAfterProbe(hasPlayer, window)` — if no player is registered (secure-context failure, see §13), status becomes the insecure-origin notice with `kind:'error'`, otherwise `"Ready"`. The connect button is disabled until the probe completes.

#### 11.5 Connect button (`openStream`)
Reads all form values *before* closing the dialog (DOM removal would lose them). Builds `VideoSettings` + a `ParamsStreamScrcpy` carrying `videoCodec`, `audioCodec`, `audioEnabled`, `audioSource`, `encoderName`, then lazily imports and opens `ConnectModal`.

---

### 12. VideoSettings — client model, wire format (legacy binary form unused by current WS protocol but retained for `CommandControlMessage.createSetVideoSettingsCommand`)

File `src/app/VideoSettings.ts`. Fields: `crop?`, `bitrate`, `bounds?`, `maxFps`, `iFrameInterval`, `sendFrameMeta` (default `false`), `lockedVideoOrientation` (default `-1`), `displayId` (default `0`), `codecOptions?`, `encoderName?`.

`toUint8Array`/`fromUint8Array` binary layout (`BASE_BUFFER_LENGTH=35` + variable trailer):
```
int32 bitrate | int32 maxFps | int8 iFrameInterval
int16 width | int16 height | int16 crop.left | int16 crop.top | int16 crop.right | int16 crop.bottom
int8 sendFrameMeta | int8 lockedVideoOrientation | int32 displayId
int32 codecOptionsLen [+ bytes] | int32 encoderNameLen [+ bytes]
```
Persistence: `BasePlayer.putVideoSettingsToStorage` writes a plain-JSON object (`JSON.parse(JSON.stringify(videoSettings))`) via `settingsService.setDeviceVideo(udid, { settings, fit })` — never a class instance. Reads coerce the stored plain object back into a `VideoSettings` instance (`getVideoSettingFromStorage`), falling back to the player's `preferredVideoSettings` on cache miss, and tolerating a stored `bounds: null`.

`WebCodecsPlayer.preferredVideoSettings`: `{ lockedVideoOrientation: -1, bitrate: 8_000_000, maxFps: 15, iFrameInterval: 2, bounds: Size(0,0), sendFrameMeta: false }`.

#### 12.1 Mapping `VideoSettings` → stream URL query (`src/common/StreamUrlParams.ts: applyStreamParams`)
- `bitrate` → `bitrate` param (only if truthy).
- `maxFps` → `maxFps` param.
- `bounds` → `maxSize` = `max(width, height)` (only if >0) — scrcpy's single max-dimension clamp.
- `displayId` → `displayId` param.
- `iFrameInterval`+`codecOptions` → merged into `videoCodecOptions` via `buildVideoCodecOptions` (§11.2).
- `videoCodec`/`audioCodec` omitted from the URL when equal to the scrcpy default (`h264`/`opus` respectively) — pure serialization optimization, not a feature.
- `audioEnabled` → `audio=true|false` only if explicitly a boolean (undefined means "let server default").
- `audioSource`, `encoderName` → passed through verbatim if present.

---

### 13. Secure-context gating — `src/app/secureContext.ts`

WebCodecs (`VideoDecoder`) is only exposed in a secure context. On plain `http://<lan-ip>:8000`, `VideoDecoder` is `undefined`, `WebCodecsPlayer.isSupported()` is `false`, and `StreamClientScrcpy.players` stays empty — every downstream UI path (device card link, Configure modal connect button) then silently does nothing.

- `insecureOriginNotice(win)`: returns `null` if `win.isSecureContext`, else the message:
  > *"this address is not a secure origin, so the browser will not expose the video decoder and no stream can start. turn on local https in settings → local https for the quickest fix on your own network, open `<loopback-equivalent>` on the machine running ws-scrcpy-web, or serve this app over https from a trusted origin for anything beyond a home lan."*
- `loopbackEquivalent(location)`: same protocol+port on `localhost`.
- `statusAfterProbe(hasPlayer, win)`: `{text:'Ready'}` if a player exists; else the insecure-origin notice with `kind:'error'`.
- Measured fact: Chromium's `--unsafely-treat-insecure-origin-as-secure` flag does **not** restore WebCodecs (tested 2026-09-03, Chromium 151) — loopback or real HTTPS are the only remedies.

---

### 14. Stream-client lifecycle — `src/app/googDevice/client/StreamClientScrcpy.ts`

`StreamClientScrcpy.start(query, player?, fitToScreen?, videoSettings?, container?, onDisconnect?, deviceKind?)` → `{instance, stop}`.

`startStream()`:
1. `settingsService.hydrateDevice(udid)` (idempotent, guards sync reads).
2. Instantiates the requested player class (registered via `registerPlayer`, filtered by `isSupported()`).
3. Registers `video-stalled` listener → sends `CommandControlMessage(TYPE_RESET_VIDEO)` on the demuxer's control channel (client-driven keyframe recovery, complementing the server's own).
4. Builds `deviceView` DOM: toolbar (`GoogToolBox`), `.video` container with a "clipboard copy" prompt overlay and a hidden `.stream-locked-notice` banner (text: *"device is locked — unlock it to see the screen"*).
5. If `fitToScreen`, recomputes `videoSettings.bounds` from `getMaxSize()` = `(window.innerWidth - toolbarWidth) & ~15` × `(window.innerHeight) & ~15` (16-px aligned, viewport-based, not container-based — container may not be sized yet inside a `fit-content` modal).
6. Registers one-shot `click`/`keydown` document listeners to resume the `AudioContext` (browser autoplay policy).
7. Codec resolution: explicit `params.videoCodec` is verified against `browserSupportsCodec`; falls back to h264 with cleared `encoderName` if unsupported. No explicit codec → `detectBestCodecAndEncoder` (device probe + `chooseCodec`); probe failure falls back to `chooseCodecWithoutProbe` and surfaces via `onErrorReceived` if that itself throws.
8. Opens `ScrcpyDemuxer(streamUrl)`, wires all 5 callbacks, always enables keyboard capture (`setHandleKeyboardEvents(true)`).

#### 14.1 `onMetadata`
Sets player session info (codec/encoder/resolution — feeds stats overlay and `onMetadataReceived` public hook); constructs an `AudioPlayer(audioCodec)` and calls `.start()` unless `audioCodec` is `'disabled'`/`'error'`.

#### 14.2 `onSessionChange` (rotation/resize, `ChannelId.SESSION`)
Calls `player.onSourceResize(width, height)` if present. Deliberately does **not** touch audio or session-info overlay (would spawn a duplicate `AudioPlayer` per rotation if routed through `onMetadata`).

#### 14.3 Disconnect routing (`onDisconnected`)
- Failure classification happens *first*, before any callback can flip `isStopping`.
- A user-initiated stop (`stopFn`/`refreshStream`) sets `isStopping=true` beforehand, so its own close never fires `onErrorReceived`.
- `isRefreshing` short-circuits teardown of the touch handler (a `refreshStream()` reconnect is not session end).
- Exactly one of `onErrorReceived(failure)` or `onDisconnectCallback()` fires.

#### 14.4 "No picture" / locked-device detection — `looksLikeNoPicture`
- Tracks a 30-frame rolling average of encoded frame size (`RollingWindow`, excludes config frames). Baseline built from the first 30 samples.
- `looksLikeNoPicture(avg, baseline)`: true if `avg < baseline*0.1` (relative drop, catches mid-session lock) **or** `avg < NO_PICTURE_FRAME_BYTES=1000` (absolute, catches connecting onto an already-locked phone where no healthy baseline ever exists).
- `checkForDegradation`: needs ≥10 samples; 5 consecutive degraded evaluations trigger `refreshLockedNotice()` (throttled to once per `LOCK_CHECK_INTERVAL_MS=5000`, fetches `GET /api/devices/screen-state?udid=...`, shows/hides the lock banner based on `{locked:boolean}`; silently no-ops on fetch failure — never falsely accuses a working stream).
- Recovering to a healthy average resets the degradation counter and hides the banner.

#### 14.5 `refreshStream()`
Resets frame-size tracking, detaches the old demuxer's `onDisconnect` *before* closing it (avoids a race where the async `onclose` fires `onDisconnected` with a stale `isRefreshing` state), stops audio, calls `player.stop()`+`player.pause()`, then opens a brand-new `ScrcpyDemuxer` against the same `buildStreamUrl()`. Triggered by the toolbar "Refresh stream" button.

#### 14.6 `getMaxSize()`
See §14 step 5 — recomputed on demand, not cached, so a window resize before reconnect is picked up.
…


[Showing lines 1-300 of 421. Use :301 to continue]


## B.2 Input & control


### Summary

Input is sent to the Android device over a scrcpy control socket, tunneled through a WebSocket "channel 2" (`src/server/.../ScrcpyConnection`). The client offers two independent, mutually-exclusive input subsystems per stream: (1) **software-injected input** via scrcpy's `ControlMessage` protocol (touch/scroll/keycode/text/clipboard/file-push), gated by a D-pad/Touch toggle; and (2) **hardware UHID input** (virtual USB keyboard+mouse), which, when enabled, disables (1)'s touch and keyboard paths. Device clipboard delivery has a browser-permission fallback prompt. Drag-and-drop file push streams chunks over a dedicated WebSocket channel with per-chunk ack/response.

### Files

- `src/app/controlMessage/ControlMessage.ts` — message type IDs (0–17, 101, 102).
- `src/app/controlMessage/TouchControlMessage.ts`, `ScrollControlMessage.ts`, `KeyCodeControlMessage.ts`, `TextControlMessage.ts`, `CommandControlMessage.ts`, `UhidCreateMessage.ts`, `UhidInputMessage.ts`, `UhidDestroyMessage.ts` — wire-format encoders.
- `src/app/interactionHandler/InteractionHandler.ts` — shared touch/mouse geometry, pointer-id tracking, multi-touch mirroring, canvas overlay drawing.
- `src/app/interactionHandler/FeaturedInteractionHandler.ts` — D-pad vs Touch mode logic, scroll handling, back/home button mapping.
- `src/app/interactionHandler/multiTouchKey.ts`, `pointerRelease.ts` — small predicate helpers used by the above.
- `src/app/googDevice/KeyInputHandler.ts` — legacy Android-keycode keyboard path (singleton, static listener fan-out).
- `src/app/googDevice/KeyToCodeMap.ts`, `src/app/googDevice/android/KeyEvent.ts` — `KeyboardEvent.code` → Android keycode table and constants.
- `src/app/googDevice/UhidManager.ts`, `UhidKeyboardHandler.ts`, `UhidMouseHandler.ts`, `hid-usage-tables.ts` — UHID subsystem.
- `src/app/googDevice/client/ClipboardCopyPrompt.ts` — browser-permission fallback UI for device→host clipboard sync.
- `src/app/googDevice/client/StreamClientScrcpy.ts` — wiring/owner of all of the above per stream.
- `src/app/googDevice/toolbox/GoogToolBox.ts` — toolbar buttons/checkboxes that drive input-mode state.
- `src/app/googDevice/DragAndDropHandler.ts` — generic static drag/drop dispatcher.
- `src/app/googDevice/filePush/FilePushHandler.ts`, `AdbkitFilePushStream.ts`, `FilePushStream.ts`, `FilePushResponseStatus.ts` — client-side file-push state machine.
- `src/server/goog-device/filePush/FilePushReader.ts` — server-side file-push state machine (adb push / temp file accumulation).
- `src/app/googDevice/DeviceMessage.ts` — server→browser message decoding (clipboard, ack, UHID output, push response).
- `src/app/MotionEvent.ts` — action/button constants.

### Architecture

Input flows: DOM events → `InteractionHandler`/`KeyInputHandler`/`Uhid*Handler` → `ControlMessage` subclass → `.toUint8Array()` → `StreamClientScrcpy.sendMessage()` → WebSocket channel 2 → server strips channel byte → scrcpy-server control socket. Device→browser clipboard/UHID-output/push-response arrive as `DEVICE_MSG` frames, decoded by `DeviceMessage`, routed by `StreamClientScrcpy.OnDeviceMessage`. File push uses a separate adb-push-style protocol over its own channel (`Protocol.SEND`), independent of the scrcpy control socket except that `CommandControlMessage.createPushFileCommand` reuses the `ControlMessage` framing (`TYPE_PUSH_FILE = 102`, a ws-scrcpy-specific extension not in vanilla scrcpy).

---

### 1. Control-message wire formats (browser → server, channel 2)

All messages begin with a 1-byte `type`. `ControlMessage.ts:7-25` enumerates:

| Constant | ID | Notes |
|---|---|---|
| `TYPE_KEYCODE` | 0 | Android keycode press/release |
| `TYPE_TEXT` | 1 | Raw text injection |
| `TYPE_TOUCH` | 2 | 31-byte payload |
| `TYPE_SCROLL` | 3 | 20-byte payload |
| `TYPE_BACK_OR_SCREEN_ON` | 4 | (constant only; not sent by this codebase — back is sent as `TYPE_KEYCODE`) |
| `TYPE_EXPAND_NOTIFICATION_PANEL` | 5 | |
| `TYPE_EXPAND_SETTINGS_PANEL` | 6 | |
| `TYPE_COLLAPSE_PANELS` | 7 | |
| `TYPE_GET_CLIPBOARD` | 8 | payload: `copy_key` u8 |
| `TYPE_SET_CLIPBOARD` | 9 | payload: sequence u64 BE, paste u8, textLen u32 BE, text |
| `TYPE_SET_SCREEN_POWER_MODE` | 10 | payload: mode u8 (0/1) |
| `TYPE_ROTATE_DEVICE` | 11 | |
| `TYPE_UHID_CREATE` | 12 | |
| `TYPE_UHID_INPUT` | 13 | |
| `TYPE_UHID_DESTROY` | 14 | |
| `TYPE_OPEN_HARD_KEYBOARD_SETTINGS` | 15 | |
| `TYPE_START_APP` | 16 | |
| `TYPE_RESET_VIDEO` | 17 | |
| `TYPE_CHANGE_STREAM_PARAMETERS` | 101 | ws-scrcpy extension; carries `VideoSettings` bytes |
| `TYPE_PUSH_FILE` | 102 | ws-scrcpy extension; file-push protocol |

#### 1.1 `TouchControlMessage` (`TouchControlMessage.ts`)
32 bytes total (1 type + 31 payload, `PAYLOAD_LENGTH = 31`):
```
0  1  type (0x02)
1  1  action (DOWN=0, UP=1, MOVE=2)
2  4  pointerId high 32 bits (always 0)
6  4  pointerId low 32 bits
10 4  x (uint32 BE)
14 4  y (uint32 BE)
18 2  screen width (uint16 BE)
20 2  screen height (uint16 BE)
22 2  pressure (uint16 BE, 0x0000–0xFFFF)
24 4  actionButton (uint32 BE)
28 4  buttons (uint32 BE)
```
Pressure is clamped to `[0,1]` before scaling (`TouchControlMessage.ts:48`: guards NaN/out-of-range `force` from silently wrapping — fix for issue #93). `MAX_PRESSURE_VALUE = 0xFFFF`.

#### 1.2 `ScrollControlMessage` (`ScrollControlMessage.ts`)
21 bytes (1 type + 20 payload):
```
0  1  type (0x03)
1  4  x (uint32 BE)
5  4  y (uint32 BE)
9  2  screen width
11 2  screen height
13 2  hScroll (int16 BE, i16 fixed-point)
15 2  vScroll (int16 BE, i16 fixed-point)
17 4  buttons (uint32 BE)
```
`SCROLL_DIVISOR = 128` (ws-scrcpy-specific; upstream scrcpy desktop uses 16 — chosen here "for slower, smoother scrolling over latent streams", issue #94). Encoding: `norm = clamp(tick/128, -1, 1)`; `floatToI16FP(f) = f<0 ? -round(-f*0x8000) : round(f*0x7fff)` (matches scrcpy's `sc_float_to_i16fp`).

#### 1.3 `KeyCodeControlMessage` (`KeyCodeControlMessage.ts`)
14 bytes (1 type + 13 payload):
```
0  1  type (0x00)
1  1  action (DOWN=0, UP=1 — KeyEvent.ACTION_*)
2  4  keycode (int32 BE, Android KeyEvent code)
6  4  repeat (int32 BE)
10 4  metaState (int32 BE, Android meta bitmask)
```

#### 1.4 `TextControlMessage` (`TextControlMessage.ts`)
`type(1) + textLen(uint32 BE) + utf8 text bytes`. Only constructed via `TextControlMessage`; **no caller in the input pipeline reads from this** — not wired to IME text input in the reviewed files `[unverified: no construction site found outside controlMessage/__tests__]`.

#### 1.5 `CommandControlMessage` (`CommandControlMessage.ts`)
Zero-length base payload (`PAYLOAD_LENGTH=0`); most instances overwrite `buffer` via static factories:
- `createSetVideoSettingsCommand(videoSettings)` → `TYPE_CHANGE_STREAM_PARAMETERS` + serialized `VideoSettings`.
- `createGetClipboardCommand(copyKey = COPY_KEY_NONE)` → `TYPE_GET_CLIPBOARD`, 2 bytes: `type, copy_key`. `COPY_KEY_NONE=0`, `COPY_KEY_COPY=1`, `COPY_KEY_CUT=2`. Comment notes scrcpy's `parseGetClipboard` always reads a copy_key byte — omitting it desyncs the stream (prior bug fix).
- `createSetClipboardCommand(text, paste=false, sequence=0n)` → `TYPE_SET_CLIPBOARD`: `type(1) + sequence(u64 BE) + paste(u8) + textLen(i32 BE) + text`.
- `createSetScreenPowerModeCommand(mode: boolean)` → `TYPE_SET_SCREEN_POWER_MODE`, 2 bytes.
- `createPushFileCommand(params)` → dispatches to START/APPEND/CANCEL/FINISH/NEW sub-encoders (§5).

#### 1.6 UHID messages
- `UhidCreateMessage` (`UhidCreateMessage.ts`): `type(1)+id(u16 BE)+vendorId(u16 BE)+productId(u16 BE)+nameLen(u8)+name+descLen(u16 BE)+descriptor`. `vendorId=productId=0` (matches scrcpy's own uhid clients). Two static constructors: `createKeyboard(id)` → name `"ws-scrcpy keyboard"` + 63-byte standard boot-protocol keyboard descriptor (modifier byte + reserved byte + 6 key slots, usage range 0–101); `createMouse(id)` → name `"ws-scrcpy mouse"` + mouse descriptor (buttons byte [5 buttons + 3-bit pad], relative int8 dx/dy/wheel).
- `UhidInputMessage` (`UhidInputMessage.ts`): `type(1)+id(u16 BE)+size(u16 BE)+data`. `createKeyboardReport(id, modifier, keycodes[])` → 8-byte report `[modifier, 0, key1..key6]` (keycodes beyond 6 ignored). `createMouseReport(id, buttons, dx, dy, wheel)` → 4-byte report `[buttons, dx&0xff, dy&0xff, wheel&0xff]`, each of dx/dy/wheel clamped to `[-127,127]` before masking.
- `UhidDestroyMessage` (`UhidDestroyMessage.ts`): `type(1)+id(u16 BE)`, 3 bytes.

---

### 2. Device → browser messages (`DeviceMessage.ts`)

| Constant | ID | Payload |
|---|---|---|
| `TYPE_CLIPBOARD` | 0 | `length(i32 BE) + utf8 text` |
| `TYPE_ACK_CLIPBOARD` | 1 | `sequence (u64 BE)` |
| `TYPE_UHID_OUTPUT` | 2 | not decoded in reviewed code (`[unverified]` beyond type constant) |
| `TYPE_PUSH_RESPONSE` | 101 | ws-scrcpy-specific; `id(i16 BE) + code(i8)` |

Delivered via `DEVICE_MSG` channel frames, reassembled by `DeviceMessageFramer` (per TECHNICAL_GUIDE.md:148: an unknown message type permanently stops reassembly for that connection since the length of an unknown type can't be determined).

---

### 3. Touch / Mouse input (software injection path)

#### 3.1 Event capture
`InteractionHandler` (`InteractionHandler.ts:93-143`) registers **static, document.body-level** listeners shared across all handler instances (one listener set regardless of active-device count). Events dispatch to interested `InteractionHandler` instances only if `event.target === this.tag` (the player's touchable `<canvas>`). `touchEventsNames` for `FeaturedInteractionHandler`: `touchstart, touchend, touchmove, touchcancel, mousedown, mouseup, mousemove, wheel`; `keyEventsNames`: `keydown, keyup`.

#### 3.2 Pointer-id management
`InteractionHandler.getPointerId(type, identifier)` (`InteractionHandler.ts:~215`) maps DOM touch identifiers (or `0` for mouse) to scrcpy pointer IDs via two static `Map`s shared globally. On a release event (`pointerRelease.ts`: `touchend`, `touchcancel`, `mouseup`), the mapping is freed — fixes a leak where the mouse's pointer-id-0 entry was never released across repeated interactions (issue #47).

#### 3.3 Coordinate translation (`buildTouchOnClient`, `InteractionHandler.ts:~225-270`)
1. `getBoundingClientRect()` on the canvas target.
2. `touchX/Y = clientX/Y - rect.left/top`.
3. Out-of-bounds (negative or beyond `clientWidth/Height`) → `invalid = true`.
4. Letterbox correction: compares device aspect ratio (`videoSize.width/height`) vs. the canvas's rendered aspect ratio using fixed-point comparison (`eps = 1e5`); adjusts for top/bottom or left/right black bars, marking `invalid` if the point falls in the bar.
5. Scales corrected client coords to device screen coordinates: `x = touchX * width / clientWidth`, same for y.
6. Final bounds check against `[0, width] x [0, height]`.
7. Returns `{ client: {width,height}, touch: {invalid, action, position, buttons} }`.

#### 3.4 Action mapping
`EVENT_ACTION_MAP` (`InteractionHandler.ts:60-70`): `touchstart/mousedown → ACTION_DOWN(0)`, `touchend/mouseup → ACTION_UP(1)`, `touchmove/mousemove → ACTION_MOVE(2)`, `touchcancel → ACTION_UP(1)`.

#### 3.5 Pressure
- Touch events: `pressure = 1` unless `action === ACTION_UP` (→0) or `touch.force` is a number (uses raw `force`, 0–1).
- Mouse-synthesized touch (`buildTouchEvent`): `pressure = 1.0` normally, `0` on `ACTION_UP`.
- Clamped again to `[0,1]` at encode time (§1.1).

#### 3.6 Multi-touch simulation (`getTouch`, `InteractionHandler.ts:~155-200`)
Gated on `ctrlKey` (held during a mouse event):
- `ctrlKey` not held → clears multi-touch state, returns the single real touch.
- `ctrlKey` held, first frame of gesture:
  - `shiftKey` held → mirror center = current point (`multiTouchShift = true`), opposite point = `2*center - point` (reflected across the clicked point), invalid if outside screen bounds.
  - `shiftKey` not held → mirror center = canvas center (`client.width/2, client.height/2`), opposite point = `client.width - x, client.height - y` (point reflection through canvas center).
- Produces 2 `Touch` entries (pointerId 0 and a second synthetic pointer) each frame while `ctrlKey` held; both get `drawPointer`/`drawCenter` canvas overlays (green `#00BEA4` stroke, touch-point/center-point PNG icons).
- `multiTouchKey.ts` — `shouldHandleMultiTouchKey({repeat, ctrlKey, shiftKey})`: a `keydown/keyup` only triggers an immediate rebuild of the synthetic gesture if non-repeat AND (`ctrlKey` or `shiftKey`) held — avoids rebuilding on every OS auto-repeat (issue #46).

#### 3.7 Touch-state validation (`validateMessage`, `InteractionHandler.ts:~245-290`)
Per `storage: Map<pointerId, TouchControlMessage>`:
- **ACTION_UP**: removes from storage, forwards the UP.
- **ACTION_DOWN** with a stale previous DOWN already stored (e.g., a lost `mouseup` during reconnect/focus change) → injects a synthetic UP for the stale pointer first, then stores/forwards the new DOWN.
- **ACTION_MOVE** with no stored previous DOWN but `buttons` indicate a button is held (mouse) or any `TouchEvent` → logs a warning and synthesizes a DOWN before the MOVE.
- **ACTION_MOVE** with a previous DOWN → forwards normally.
- After processing, if any message in the batch was an UP but other pointers remain in `storage`, a warning is logged ("one of Multi-touch pointers was not raised up") and synthetic UPs are emitted for all remaining stored pointers, clearing storage — recovery for partially-released multi-touch gestures.

#### 3.8 Mouse-leave cleanup
`FeaturedInteractionHandler.onMouseLeave` (`FeaturedInteractionHandler.ts:~215`): on `mouseleave`, sends synthetic `ACTION_UP` for every message in `storedFromMouseEvent`, clears the map, clears the canvas overlay. Keyboard-triggered multi-touch state resets if `lastPosition` becomes `undefined`.

---

### 4. D-pad / Touch mode toggle

Toolbar checkbox (`GoogToolBox.ts:119-142`), icon `DPAD`/`TOUCH_HAND`, id `input_mode_${udid}_${playerName}`; title toggles between `"D-pad mode (click for Touch mode)"` and `"Touch mode (click for D-pad mode)"`.

**Default per device kind** (`GoogToolBox.ts:130`): `startInTouch = deviceKind === 'phone' || deviceKind === 'tablet'`. Phone/tablet default to **Touch mode**; `tv` or unspecified kind default to **D-pad mode** (`_dpadMode = true` initial value in `FeaturedInteractionHandler`).

Click handler calls `client.setDpadMode(!touchMode)` → `StreamClientScrcpy.setDpadMode()` (`StreamClientScrcpy.ts:692-694`) → `touchHandler?.setDpadMode(enabled)`.

#### 4.1 D-pad mode behavior (`FeaturedInteractionHandler.onInteraction`)
- **Left mousedown/up** (`button===0`) → `KeyCodeControlMessage(ACTION_DOWN/UP, KEYCODE_DPAD_CENTER(23), 0, 0)`.
- **Wheel** → `buildDpadScrollEvent`: fire-then-debounce. On first wheel event, fires immediately and enters a 400ms cooldown (`DPAD_SCROLL_DEBOUNCE_TIME`); subsequent events during cooldown reset the debounce timer but do not fire (absorbs a single hardware scroll-wheel "click" burst into one keypress). Direction: plain scroll → vertical (`deltaY>0 → DPAD_DOWN`, `deltaY<0 → DPAD_UP`); `shiftKey` held → horizontal (`deltaY>0 → DPAD_LEFT` reversed logic: code computes `hDir` from `deltaY` when shift held, sign flipped vs vertical: `hDir = deltaY>0?-1:deltaY<0?1:0` then `hDir===-1→DPAD_RIGHT`, `hDir===1→DPAD_LEFT`); non-shift horizontal wheel (`deltaX`) also maps similarly. Each direction emits a DOWN+UP pair of `KeyCodeControlMessage`.
- Right-click/middle-click → BACK/HOME (same as touch mode, §4.3).

#### 4.2 Touch mode behavior
- Left-click/touch → regular `TouchControlMessage` pipeline (§3).
- **Wheel** → `buildScrollEvent`: throttled to one message per 30ms (`SCROLL_EVENT_THROTTLING_TIME`) unless scroll direction changed; computes `hScroll`/`vScroll` as `-1/0/1` from `deltaX`/`deltaY` sign, builds `ScrollControlMessage` at the pointer's translated screen position.
- Right-click/middle-click → BACK/HOME (same as D-pad mode).

#### 4.3 Button→keycode map (both modes, `FeaturedInteractionHandler.ts:~135`)
```
BUTTON_KEYCODE_MAP = {
  2 (right-click)  → KEYCODE_BACK,
  1 (middle-click) → KEYCODE_HOME,
}
```
Applies on `mousedown`/`mouseup`; always preempts the mode-specific handling, `event.preventDefault()`/`stopPropagation()` called.

---

### 5. Keyboard input — legacy keycode path (`KeyInputHandler.ts`)

Singleton static class with its own `document.body` `keydown`/`keyup` listeners, attached/detached lazily as the listener `Set` becomes non-empty/empty (`KeyInputHandler.addEventListener`/`removeEventListener`). Default-enabled per stream (`StreamClientScrcpy.ts:569`: `setHandleKeyboardEvents(true)` on connect) and toggleable via toolbar checkbox "Capture keyboard" (`GoogToolBox.ts:84-92`, checked by default, id `capture_keyboard_${udid}_${playerName}`).

- `KeyToCodeMap` (`KeyToCodeMap.ts`) is a `Map<UIEventsCode, AndroidKeyCode>` covering letters, digits, punctuation, modifiers (`AltLeft/Right`, `ControlLeft/Right`, `ShiftLeft/Right`, `MetaLeft/Right`), navigation (arrows→DPAD_*, Home/End/PageUp/Down/Insert/Delete), numpad (0-9, operators, Enter, parens), function keys F1-F12, Escape, Tab, Enter, Backspace, Space, CapsLock, NumLock, PrintScreen(→SYSRQ), Pause(→BREAK), Fn(→FUNCTION), IME `KanaMode`, `IntlRo`, `IntlYen`. Unmapped codes are silently dropped (`if (!keyCode) return;`).
- **Repeat counting**: a per-keycode counter (`repeatCounter: Map<keycode, count>`) increments on each `keydown` with `event.repeat === true`; reset/deleted on `keyup`. Sent as the `repeat` field of `KeyCodeControlMessage`.
- **Meta state bitmask** built from `getModifierState()` for Alt, Shift, Control, Meta, CapsLock, ScrollLock, NumLock, each OR'd with the corresponding `KeyEvent.META_*_ON` constant.
- Every handled key calls `event.preventDefault()` (browser default suppressed for any mapped key).
- Fan-out: each registered `KeyEventListener.onKeyEvent(message)` is invoked (`StreamClientScrcpy.onKeyEvent` just forwards to `sendMessage`).

---

### 6. UHID hardware input subsystem

Toggle: toolbar checkbox "UHID Input (keyboard + mouse)" (`GoogToolBox.ts:97-107`, id `uhid_input_${udid}_${playerName}`, icon `KEYBOARD`, unchecked by default) → `client.toggleUhid(checked)`.

#### 6.1 Lifecycle (`StreamClientScrcpy.toggleUhid`, `StreamClientScrcpy.ts:704-736`)
**Enable** (idempotent if already active):
1. `new UhidManager(sendMessage)`; `uhidManager.start()` → sends `UhidCreateMessage.createKeyboard(1)` then `UhidCreateMessage.createMouse(2)`.
2. `new UhidKeyboardHandler(uhidManager)`; `.attach()`.
3. If a player exists, `new UhidMouseHandler(uhidManager, player.getTouchableElement())`; `.attach()`.
4. Releases the existing touch handler (`touchHandler?.release()`, set to `undefined`) — software touch input is fully disabled while UHID is active.
5. `KeyInputHandler.removeEventListener(this)` — legacy keyboard path disabled while UHID is active.

**Disable**:
1. `uhidKeyboard?.detach()`, `uhidMouse?.detach()`, `uhidManager?.stop()` (sends `UhidDestroyMessage` for both IDs); all three refs cleared.
2. If a player exists, `setTouchListeners(player)` re-creates the touch handler — software input resumes.
(Legacy keyboard handler is **not** automatically re-enabled on UHID disable in the reviewed code path — `[unverified beyond what's shown]`.)

`UhidManager.start()`/`stop()` (`UhidManager.ts`) are idempotent guarded by an `active` boolean; `sendKeyReport`/`sendMouseReport` no-op if not active. IDs are fixed constants: `UHID_KEYBOARD_ID = 1`, `UHID_MOUSE_ID = 2`.

#### 6.2 `UhidKeyboardHandler` (`UhidKeyboardHandler.ts`)
- Listens on `document` (not scoped to canvas) `keydown`/`keyup`; every handled event calls `preventDefault()`.
- Modifier keys (`ControlLeft/Right, ShiftLeft/Right, AltLeft/Right, MetaLeft/Right`) via `MODIFIER_CODES` set/clear a bit in `modifierState` (bitmask, see `HID_MODIFIER` below) and send immediately; non-modifier keys look up `CODE_TO_HID[event.code]`, add/remove from a `pressedKeys: Set<number>` (deduped — a `keydown` for an already-pressed key is a no-op), and resend the full report.
- `sendReport()`: `keycodes = Array.from(pressedKeys).slice(0,6)` (boot-protocol 6-key limit — a 7th simultaneous key is silently dropped from the report, though still tracked in the `Set`).
- `detach()`: removes listeners, clears `pressedKeys`/`modifierState`, sends an all-zero report (releases all keys on the device side).
- HID usage table (`hid-usage-tables.ts`): `CODE_TO_HID` covers letters, digits, Enter/Escape/Backspace/Tab/Space/Minus/Equal/Bracket*/Backslash/Semicolon/Quote/Backquote/Comma/Period/Slash/CapsLock, F1-F12, PrintScreen/ScrollLock/Pause/Insert/Home/PageUp/Delete/End/PageDown/Arrow*, NumLock+full numpad, ContextMenu. **Not covered** (vs. the legacy `KeyToCodeMap`): Meta/Super keys (handled only as modifiers, no standalone usage code), IME keys (`KanaMode`, `IntlRo`, `IntlYen`), `Fn`.
- `HID_MODIFIER` bit layout: `LEFT_CTRL=0x01, LEFT_SHIFT=0x02, LEFT_ALT=0x04, LEFT_META=0x08, RIGHT_CTRL=0x10, RIGHT_SHIFT=0x20, RIGHT_ALT=0x40, RIGHT_META=0x80` (standard USB boot-keyboard modifier byte).

#### 6.3 `UhidMouseHandler` (`UhidMouseHandler.ts`) — Pointer Lock UX
- `attach()`: adds a `click` listener on the canvas that calls `canvas.requestPointerLock()`, and a `document`-level `pointerlockchange` listener.
- Mouse move/down/up/wheel listeners are only attached to `document` **while pointer lock is active** (added in `onPointerLockChange` when `document.pointerLockElement === canvas`); removed when lock is released.
- On lock loss, if any button was held, sends a zero report (`sendMouseReport(0,0,0,0)`) to release all buttons on the device.
- `onMouseMove`: `dx/dy = clamp(event.movementX/Y, -127, 127)`; sends a report only if `dx !== 0 || dy !== 0` (wheel delta 0 on move events).
- `onMouseDown`/`onMouseUp`: `buttonState |= / &= ~ (1 << event.button)` (bit 0=left/button0, bit 1=right/button1 per DOM `MouseEvent.button`, bit 2=middle/button2, etc.).
- `onWheel`: `preventDefault()`; `wheel = deltaY>0?-1:deltaY<0?1:0`; sent only if non-zero, with dx=dy=0.
- `detach()`: removes the click listener and pointerlockchange listener, removes any active mouse listeners, calls `document.exitPointerLock()` if this canvas currently holds the lock, resets `buttonState = 0`.

#### 6.4 HID report descriptors (`UhidCreateMessage.ts`)
- **Keyboard** (63 bytes): Usage Page Generic Desktop (0x05,0x01) / Usage Keyboard (0x09,0x06) / Collection Application; modifier byte as 8× 1-bit Data/Variable inputs over usage range 224–231 (left-ctrl .. right-meta); 1 reserved constant byte; 6× 8-bit Data/Array key slots over usage range 0–101.
- **Mouse** (≈54 bytes): Usage Page Generic Desktop / Usage Mouse; nested Physical collection with Usage Page Buttons (1–5) as 5× 1-bit Data/Variable + 3-bit constant padding; then Usage X/Y/Wheel as 3× 8-bit signed (-127..127) Data/Variable **Relative** inputs.
- Both devices use `vendorId = productId = 0` and names `"ws-scrcpy keyboard"` / `"ws-scrcpy mouse"` (name length capped at 255 bytes, throws if exceeded).

---

### 7. Clipboard

#### 7.1 Get (device → host)
Toolbar button "copy device selection to host clipboard" (`GoogToolBox.ts:163-166`, icon `CLIPBOARD_GET`) sends `createGetClipboardCommand(COPY_KEY_COPY)`. Comment documents the semantics: this matches scrcpy desktop's `MOD+c` shortcut — the device executes a COPY action on its current selection, and because clipboard autosync is left on, the resulting text arrives asynchronously as a `DEVICE_MSG` → `TYPE_CLIPBOARD` message (not a direct reply to this command). No-op if there is no selection; on Android 5/6 the server cannot inject `KEYCODE_COPY` (added API 24) so nothing happens there either.

#### 7.2 Set (host → device)
Toolbar button "push host clipboard to device" (`GoogToolBox.ts:170-182`, icon `CLIPBOARD_SET`): requires `navigator.clipboard.readText` (else logs an error and no-ops); on success with non-empty text, sends `createSetClipboardCommand(text)` (`paste=false`, `sequence=0n` — no paste-trigger, no ack tracking from the UI).

#### 7.3 Device→host clipboard delivery & fallback prompt
`StreamClientScrcpy.OnDeviceMessage` (`StreamClientScrcpy.ts:292-296`): on `DeviceMessage.TYPE_CLIPBOARD`, calls `clipboardPrompt.deliver(text)`.

`ClipboardCopyPrompt` (`ClipboardCopyPrompt.ts`) — one instance per stream, appended into the video container:
- `deliver(text)`: bumps a `generation` counter (invalidates any in-flight older write/prompt). If `navigator.clipboard.writeText` doesn't exist, immediately shows the offer UI (`offer`). Otherwise attempts `navigator.clipboard.writeText(text)`:
  - **resolves** → if still the latest generation, hides the prompt (silent success — this is the common Chrome, focused-page case).
  - **rejects** (Safari/Firefox refusal, or no `clipboard-write` permissions-policy grant in an iframe embed) → if still latest, calls `offer(text)`.
- `offer(text)`: stores `pendingText`, unhides the prompt element (`role="status"`, text "Device clipboard ready —", a "click to copy" button, and a "×" dismiss button), (re)arms a 30-second auto-hide timer (`AUTO_HIDE_MS = 30_000`).
- Clicking "click to copy" (`onCopyClick`): first tries the **synchronous** legacy `document.execCommand('copy')` path via a hidden, off-screen, `readonly`, `opacity:0` `<textarea>` (selected, copied, removed; restores prior focus) — this works even in iframes lacking the `clipboard-write` permission, because it's synchronous inside the click and doesn't go through the async Clipboard permission check. If that's unavailable/fails, falls back to `navigator.clipboard.writeText` from directly inside the click handler (satisfies the user-gesture requirement some browsers enforce).
- Dismiss button and auto-hide both call `hide()` (clears timer, clears pending text, hides element).
- `dispose()` (called when the stream stops, `StreamClientScrcpy.ts:482`): bumps `generation` (orphans any in-flight write) and clears the timer — prevents a late write or stale timer from re-showing a prompt after the stream view is torn down.
- Only the newest device-clipboard delivery is ever offered or tracked; an older in-flight write settling late cannot override a newer delivery's state.

---

### 8. Drag-and-drop file push

#### 8.1 Drop target wiring
`DragAndDropHandler` (`DragAndDropHandler.ts`) is a generic static dispatcher keyed by DOM element identity:
- `dragenter`/`dragleave`/`drop` handlers look up all registered `DragEventListener`s whose `getElement()` matches `ev.currentTarget`, and call `onDragEnter`/`onDragLeave`/`onFilesDrop(files)` respectively; any handler returning `true` calls `ev.preventDefault()`.
- `dragover` always calls `preventDefault()` (required to allow drop).
- Files are extracted via `dataTransfer.items` (filtered to `kind === 'file'`) when present, else `dataTransfer.files`.

`FilePushHandler` (`FilePushHandler.ts`) implements `DragEventListener`/`DragAndPushListener`, registering itself against a given container `element` (e.g. the file-list modal body, or — per `ListFilesModal.ts:1154-1156` — a programmatic `onFilesDrop` call for manually-selected files via an `<input type=file>` too).
- `onDragEnter`/`onDragLeave` (`ListFilesModal.ts:1163-1178`): tracks an `enterCount` (handles nested child drag events); shows/hides a `dropZone` overlay (`display:flex`/`none`) only at count 0→1 / 1→0 transitions.
- `onDrop` (`ListFilesModal.ts:1180-1183`): resets `enterCount` to 0, hides the drop zone, returns `true` (handled).

#### 8.2 File-push client state machine (`FilePushHandler.pushFile`, `FilePushHandler.ts:70-139`)
Per file, over a dedicated channel (`filePushStream.sendEventNew/Start/Append/Finish`, built on `CommandControlMessage.createPushFileCommand`):
…

…

…
| Any `click`/`keydown` on document (one-shot) | always (audio) | resumes suspended `AudioContext` for autoplay policy — not an input-injection path, documented for completeness |

[Showing lines 1-300 of 344. Use :301 to continue]


## B.3 Device management


Scope: `src/app/googDevice/client/DeviceTracker.ts`, device-card UI, network discovery (`src/server/network/*`), scan client modals (`ScanNetworkModal`, `ScanProgressChip`, `NetworkDiscoveryPanel`, `AddSubnetModal`, `LargeSubnetWarningModal`), manual connect, QR/code pairing (`src/server/pairing/*`, `PairingApi`), device labels (`DeviceStore`), sleep/wake, disconnect, server-side device tracking, device-kind detection. Windows-only code excluded.

---

#### 1. Device card (`DeviceTracker.ts`, `devicelist.css`)

Rendered into `#devices .device-list` by `buildDeviceRow` (`src/app/googDevice/client/DeviceTracker.ts:191-345`). One `<div class="device active|not-active">` per adb transport.

**Border/state CSS** (`devicelist.css:95-103`): `active` → 3px green left border; `not-active` → 3px red left border + `opacity:0.7`.

**Table rows** (fixed, in order): Device Name (editable), Model (`ro.product.model`, prefixed with manufacturer unless the model string already starts with it), Device ID (`ro.serialno`/udid, monospace), Android (`ro.build.version.release`, major version only — split on `.`[0]), SDK (`ro.build.version.sdk`).

**Device Name cell** (`buildLabelCell`, `DeviceTracker.ts:448-559`): display mode shows `label || 'Unnamed Device'` (class `unnamed` when empty) plus a pencil button. Edit mode: text input (no length limit enforced client- or server-side) + check(save)/Enter to save, Escape to cancel. Save does `PUT /api/devices/labels {serial, label}`; UI re-renders the just-typed value immediately regardless of network outcome (optimistic). Label map is fetched **once per table refresh** via `fetchRowContext` → `GET /api/devices/labels` (not per-row) to avoid a request storm.

**Actions row** (`.device-actions`, 2-column grid, border divider between cells):
- **Disconnect button** — shown only when `device.udid.includes(':')` (network/TCP transport; never for USB). Click → disables itself, `POST /api/devices/disconnect {address: udid}`; re-enables itself only on local fetch exception (not on a non-2xx JSON response — success/failure UI feedback is absent here; the row disappears naturally once adb reports it gone).
- **Sleep/wake button** — shown for every device. Three visual/text states driven by `device['screen.state']`:
  - `unknown` → class `state-unknown`, text `checking...`, disabled.
  - `awake` → class `state-on`, text `turn off`.
  - `asleep` (anything else) → class `state-off`, text `turn on`.
  Click → disable button, `POST /api/devices/sleep-wake {udid, action: isAwake ? 'sleep' : 'wake'}`, then set button text/class from the JSON `{awake}` response; on throw, revert to the pre-click state. Button re-enabled via a `using` disposable in both paths.

**Services grid** (`.services`, 2×2, `grid-auto-flow: column`): left column = [shell, list files]; right column = [connect, configure stream]. Populated by each registered `Tool.createEntryForDeviceList`.
- Shell link — intercepted; opens `ShellModal`. Gated by `GET /api/capabilities` (`{shell: boolean, shellReason?}`), cached module-wide. If `shell:false`, link is visually disabled (`pointer-events:none`, `opacity:0.4`, `aria-disabled`, `tabindex:-1`) with a tooltip keyed by `shellReason`:
  - `no-seed-package` / `seed-stage-failed` → "shell unavailable — node-pty seed not staged. reinstall the app or check server logs."
  - `download-failed` / `load-failed-after-download` → "shell unavailable — no node-pty prebuilt matches your Node version. update Node in the dependencies panel or wait for the next prebuild release."
  - default → "shell unavailable. see server logs for details."
  Fetch failure fails open (shell stays enabled; server rejects at click time).
- List files links — intercepted; open `ListFilesModal`.
- Connect cell — only when `device.state === DEVICE` (active) and `CREATE_DIRECT_LINKS` is true, one per registered player class.
- Configure-stream cell — always for an active device.
- **Insecure-origin notice**: if active+direct-links but zero registered players (WebCodecs unavailable — non-secure context), a `.insecure-origin-notice` div is appended spanning both columns with the message from `insecureOriginNotice()` (`src/app/secureContext.ts:48-58`): *"this address is not a secure origin, so the browser will not expose the video decoder and no stream can start. turn on local https in settings → local https for the quickest fix on your own network, open `http(s)://localhost[:port]` on the machine running ws-scrcpy-web, or serve this app over https from a trusted origin for anything beyond a home lan."*

**Kind icon**: an icon (`DEVICE_TV`/`DEVICE_TABLET`/`DEVICE_PHONE`) is appended to the connect link per `device.deviceKind` (undefined = no icon).

**Connect click flow** (intercepted `a.link-stream`): parses stream params from URL hash, hydrates per-device settings cache (`settingsService.hydrateDevice`), applies saved or SDK-aware default audio prefs, builds a player, opens `ConnectModal` (`src/app/googDevice/client/ConnectModal.ts`) which calls `startStream` into the modal body; blocks Escape-to-close and backdrop-click while streaming; `onDisconnect` auto-closes; `onError` shows an inline red error and auto-closes after 4s.

---

#### 2. Server-side device tracking

- `ControlCenter` (`src/server/goog-device/services/ControlCenter.ts`) singleton. `POLL_INTERVAL = 5000` ms. `pollDevices()` calls `adbClient.devices()` (adb's own `devices` listing, not a persistent `track-devices` stream), diffs against `knownDevices: Map<serial,state>` to fire connect/disconnect transitions, then concurrently runs `checkScreenState()` and `detectDeviceKind()` on every currently-connected `Device`.
- `refreshNow()` — public hook called once a pairing session completes (`ControlCenter.hasInstance()` guard so pairing never starts a tracker as a side effect); forces one `pollDevices()` pass immediately instead of waiting up to 5s.
- Per-`Device` (`src/server/goog-device/Device.ts`): on `setState`, resets `properties`, clears `ro.serialno`, forgets serial-read cache and pending labels on `DISCONNECTED`, then calls `fetchDeviceInfo()`. `fetchDeviceInfo` reads properties with exponential backoff (`INITIAL_UPDATE_TIMEOUT=1500` ms, doubling, up to `MAX_UPDATES_COUNT=7` attempts) until properties and net-interfaces both succeed. On a successful property read it records the sighting under the device's real serial (`recordTrackerSighting`), applies any pending label, backfills MAC and claims the transport's network address.
- `checkScreenState()` runs `dumpsys power 2>/dev/null | grep mWakefulness` each poll tick (every 5s while connected); updates `descriptor['screen.state']` to `'awake'|'asleep'` only on change, pushing an update over the device-tracker WS.
- Device descriptor emits are throttled to one push per 300ms (`emitUpdate`, `THROTTLE=300`).

---

#### 3. Device-kind detection (`src/server/goog-device/deviceKind.ts`)

`detectDeviceKind()` runs once per device (cached on `descriptor.deviceKind`, never re-run once set) via 4 parallel shell calls, each swallowed on error:
- `getprop ro.build.characteristics`
- `pm has-feature android.software.leanback`
- `wm size`
- `wm density`

`classifyDeviceKind(characteristics, leanback, wmSize, wmDensity)`:
1. If `characteristics` contains the word `tv` (regex `\btv\b`) or `leanback.trim() === 'true'` → `'tv'`.
2. Else parse `wm size`/`wm density` strictly; if either fails to parse → `undefined` (retried next poll cycle naturally since `deviceKind` stays unset).
3. Else `smallestDp = min(width,height) / (density/160)`; `smallestDp >= 600` → `'tablet'`, else `'phone'`.

---

#### 4. Screen state / sleep-wake

- `GET /api/devices/screen-state?udid=<udid>` → runs `SCREEN_STATE_COMMAND` = `dumpsys power 2>/dev/null | grep -m1 mWakefulness; dumpsys window 2>/dev/null | grep -m1 -i isKeyguardShowing` in one shell round trip; `parseScreenState` returns `{awake, locked}` — `awake` defaults `true` and `locked` defaults `false` when the regex misses (fail toward "nothing is wrong").
- `POST /api/devices/sleep-wake {udid, action: 'sleep'|'wake'}` → 400 if either field missing. Sends `input keyevent 223` (sleep) or `224` (wake), waits 500ms, re-reads `dumpsys power 2>/dev/null | grep mWakefulness`, returns `{awake: output.includes('Awake')}`. No input validation on `udid` beyond adb's own shell-selector handling here [unverified beyond what's shown — `shArg`/serial validation lives in `AdbClient`].

---

#### 5. Disconnect

- `POST /api/devices/disconnect {address}` → 400 if missing; 400 if `!isConnectAddress(address)` (`src/server/security/deviceInput.ts`, §9 below). Runs `adb disconnect <address>`. `classifyDisconnectResult` (`DeviceDiscoveryApi.ts:30-35`): message containing `"disconnected"` → `{status:200, success:true}`; message matching `/no such device/i` → `{status:200, success:true, message:'not connected'}` (idempotent no-op); anything else → `{status:500, success:false}`. On success, `forgetPendingLabels(address)` clears any name still waiting on that transport.
- Card-side disconnect button has no success/failure message rendering — only re-enables on a thrown fetch.

---

#### 6. Device labels (`DeviceStore`, label API)

Schema: `device_labels(user_id, serial, label)` — **per-user**, keyed by `(userId, serial)`; `serial` may be the device's real `ro.serialno` OR a recorded MAC alias (both written together so a rename survives a rescan that only has MAC). No max length enforced in client or server code examined.

Routes (`DeviceDiscoveryApi.ts`):
- `GET /api/devices/labels` → `{ [serial]: label }` for the caller's `userId`.
- `PUT /api/devices/labels {serial, label}` → 400 if `serial` missing. Writes label under `serial`, and also under `db.devices.getMac(serial)` if a MAC is on file (keeps the MAC-keyed copy in sync so clearing/renaming on the card doesn't get overwritten by a MAC-only rescan hit). Empty `label` → `deleteLabel` instead of `setLabel`. Always 200 `{success:true}`.

Label resolution precedence for a scan hit (`resolveHitIdentity`, `scanIdentity.ts:70-82`): explicit label passed by caller → label under the hit's real serial (if not itself a probe address) → label under the serial observed previously at this address (DB join `findByAddress`) → label under MAC → label under the raw probe-address-as-serial (legacy fallback). Falls back to `''`.

`/api/devices/connect` persists labels: for an mDNS hit (known real serial), label is saved **before** calling `adb connect`; after a successful connect it looks up `ro.serialno` if not already known, resolves MAC (skipped in-container), resolves the "scan form" address, and writes label+MAC+claimed-address under the real serial — or, if the serial still isn't known (device slow/unauthorized), stashes the label in an in-memory `pendingLabels` map (TTL 10 minutes, `PENDING_LABEL_TTL_MS`) keyed by transport, applied the moment the serial becomes known (via device tracker or a later connect).

---

#### 7. Network scan — subnet input, validation, persistence

`SubnetParser.parseSubnetInput` (`src/common/SubnetParser.ts`) accepts three input shapes (checked in order: contains `/` → CIDR; contains `-` → range; else bare IP):

- **CIDR** `ip/prefix`: prefix must be 0–32; **effective minimum enforced prefix is /16** — prefix<16 is rejected with "Subnet too large — maximum prefix is /16 (65,534 hosts) … add multiple /16 entries using 'add subnet'". `/31` is allowed as a special 2-host case; `/32` = 1 host. Host range = network+1..broadcast-1 (standard usable range), except `/31`/`/32`.
- **Range** `startIp-endIp` or shorthand `startIp-NN` (last octet only, inherits first 3 octets): start must be ≤ end; max 65,536 addresses (one /16's worth) else rejected ("Range too large … split into multiple entries or use CIDR … /16"); network/broadcast addresses auto-skipped when the range is subnet-aligned (`.0`/`.255`).
- **Bare IP**: becomes `/32`, 1 host.
- Anything else → "Unrecognized format. Try CIDR … a single IP … or a range …".
- Every error references `/help/subnets.html` ("subnet cheat sheet").
- `isPrivate` flag: true only if the **entire** parsed range fits inside one RFC1918 block (10/8, 172.16/12, 192.168/16) — a straddling range is rejected server-side (§9).

**Persistence**: user-added (non-gateway) subnets are saved via `settingsService.patchGlobal({scanSubnets: string[]})` — a global (not per-user) settings key, raw user-typed strings, re-loaded into `ScanNetworkModal` rows on open.

**Auto-detection** (`GET /api/devices/scan/subnet`): if `inContainer()` → `{container: true}` (no subnet guessed; UI shows a "running in a container" note and 192.168.1.0/24-style example, instructs `network_mode: host` for mDNS). Otherwise `detectSubnet()` (`SubnetDetector.ts`):
  - **Linux**: parses `ip route show default`, skips `0.0.0.0` gateways, picks lowest-metric survivor, reads that interface's CIDR via `ip -o -4 addr show dev <iface>` → source `'gateway'`.
  - **Windows path exists but out of scope.**
  - Fallback (no gateway found): scans `os.networkInterfaces()` for non-internal IPv4 RFC1918 addresses with prefix in [16,32], picks the smallest-prefix (largest subnet) candidate → source `'interface'`.
  - Detected subnet becomes a non-removable row annotated "detected gateway subnet" in the modal.

**Large-subnet threshold**: total host count across all rows > **2048** → `LargeSubnetWarningModal` interposed before the scan starts. It shows total hosts, per-subnet breakdown, and an estimated duration of ~30 seconds per 1,000 hosts (rounded; <60s shown in seconds, else minutes).

---

#### 8. Network scan — WS protocol (`/ws-scan`, `src/common/ScanMessage.ts`)

Client→server:
- `{type:'scan.start', subnets: string[], mdnsOnly?: boolean}` — raw user-typed subnet strings; `mdnsOnly:true` skips the TCP track entirely (subnets may be empty).
- `{type:'scan.cancel'}`.

Server→client:
- `scan.started {totalHosts, totalSubnets, startedAt}`
- `scan.progress {checked, total, foundSoFar}` — emitted every `scanProgressInterval` (default **10**) checked hosts, and once more when `checked===total`.
- `scan.hit {source:'mdns'|'tcp', address:'IP:port', serial, name, label, model?, mayNeedPairing?}` — per-spectator label/model resolved individually (each connected user sees their own labels).
- `scan.draining {}` — emitted the instant cancel fires while workers are still winding down.
- `scan.complete {found}` / `scan.cancelled {found}`
- `scan.error {reason, details?}`

A spectator joining mid-scan (`attachSpectator`) replays the last `scan.started`/`scan.progress` snapshot and a `scan.draining` if applicable, so a late joiner isn't stuck on an empty chip.

Server guards (`ScanMw.ts`): scan-control messages capped at 256 KiB; a second `scan.start` while already scanning → `scan.error 'scan already in progress'`; each subnet is re-validated server-side (`parseSubnetInput`) and must be `isPrivate` or it's rejected per-subnet as an SSRF guard: *"'<normalized>' is outside the private (RFC1918) ranges (10/8, 172.16/12, 192.168/16); scanning public addresses is not allowed."* Client WS disconnect does **not** cancel an in-flight scan.

**Scan algorithm** (`NetworkScanner.ts`):
- Two concurrent tracks: **mDNS** (one `adb mdns services` call, filtered to services containing `_adb` but excluding `pairing`; skipped entirely if `mdnsOnly` is false... actually always run unless cancelled) and **TCP** (skipped when `mdnsOnly`).
- Pre-warm: calls injected `adbStartServer()` before dispatching workers (avoids N parallel daemon-cold-start races); a pre-warm failure emits `scan.error` and aborts the whole scan.
- TCP track: flattens all subnets' host lists, dedupes against already-connected addresses (`adb devices`, expanded via hostname→IP lookup to catch e.g. `qa-android:5555` vs `<ip>:5555`) and anything already mDNS-hit. Worker pool of `min(concurrency, hostCount)` (**default concurrency 64**, configurable `scanConcurrency`/`SCAN_CONCURRENCY`, hard ceiling **512**, clamped against an fd budget). Each worker pulls hosts off a shared cursor and runs a single-connection ADB CNXN-handshake probe (`AdbHandshakeProbe.probeAdb`) against port 5555 with `tcpTimeoutMs` (default **300ms**, connect-phase fast-fail) then `handshakeTimeoutMs` (default **5000ms** via config `scanAdbConnectTimeoutMs`, though `NetworkScanner`'s own internal default is 2000ms if the dep is omitt…
- A reply of `CNXN` → `isAdb:true` + model parsed from the banner (`dedupModel` strips doubled model strings, ReDoS-safe token walk, capped to 256 chars). `AUTH` → `isAdb:true`, no model. `STLS` → `isAdb:true, requiresPairing:true` (Android 11+ TLS-only port). Anything else / timeout / error → not ADB, silently skipped.
- On a TCP hit, resolves MAC via ARP cache (`resolveMac`, freshly populated by the just-completed TCP handshake) unless in-container.
- Dedup: `emittedAddresses` set — an address is only ever reported once per scan (mDNS claims an address first if both tracks would find it).
- Graceful socket close: `FIN` (`socket.end()`) + delayed `destroy()` (250ms grace) for a confirmed-ADB endpoint, immediate `destroy()` otherwise — some embedded adbd stacks mishandle back-to-back RSTs.
- Cancel: sets a flag; in-flight probes finish naturally (no hard abort), state transitions `scanning→draining→idle`; `scan.draining` fires the instant cancel is requested (event-driven via `Promise.race`, not polled).
- `mayNeedPairing` is set **only** from the mDNS service type (`_adb-tls-connect._tcp`), never from a TCP hit (TCP probing a TLS-only port 5555 gets AUTH/nothing, never reaches the STLS branch in practice for that flag's purposes as documented).

---

#### 9. Manual connect / scan card connect / address validation

- **`isConnectAddress`** (`deviceInput.ts`) — used for `/api/devices/connect` and `/disconnect`: optional `host[:port]`, host is a DNS-label sequence or a bracketed IPv6 literal; port (if present) numeric 1–65535; max length 300; true end-of-string anchor `(?![\s\S])` (rejects a trailing `\n` that a naive `$` would accept).
- **Manual-add form** (`NetworkDiscoveryPanel`): address (required, free text, not pre-validated client-side beyond non-empty), port (defaults `5555`; **required with no default** when opened from the "paired but not connected" pairing flow — `manualPortIsRequired`), optional label. Submits `{address: "ip:port", label}` to `/api/devices/connect`; shows inline success/error text; on success auto-hides the form after 2s.
- **Scan-card connect**: each hit card has a name input (pre-filled with any already-resolved label) and a connect button carrying `data-address`/`data-serial`; `connectDevice()` posts `{address, serial, label}`; on success the card self-removes after 1.5s; on failure shows inline error and re-enables the button.
- Server route `/api/devices/connect` is **deliberately ungated** (no `requireAdmin`) — contrasted explicitly against the admin-gated pairing routes, because connect only attaches to an already-trusted device.

---

#### 10. QR / pairing-code flow (`src/server/pairing/*`, `PairingApi`, `NetworkDiscoveryPanel` pairing section)

**mDNS service types**: `_adb-tls-pairing._tcp` (`PAIR_SVC`, advertised during pairing) and `_adb-tls-connect._tcp` (`CONNECT_SVC`, advertised post-pair).

**QR payload** (`PairingService.startQr`): `WIFI:T:ADB;S:<serviceName>;P:<password>;;` where `serviceName = "wsscrcpy-" + 10 random base32 chars` (lowercase RFC4648 alphabet) and `password` = 12 random chars from a base62-minus-ambiguous-glyphs alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789`, excludes `I l 1 O 0`). The password/payload string is converted to an SVG QR code **server-side only** (`encodeQrSvg`, vendored Nayuki QR encoder, byte mode, ECC level M, versions 1–10) and returned as markup; the raw payload/password never crosses the wire, is never logged, and `PairingStatus` has no field that could carry it.

**Session lifecycle** (`PairingSession`, states): `awaiting-scan → pairing → connecting → {paired | paired-not-connected | failed}`, or `expired` (derived at read time, only reachable from `awaiting-scan`). TTL = **180,000ms (`PAIRING_TTL_MS`)**, bounds only the scan window — once pairing starts, no further timeout applies to the session object itself (each adb call has its own timeout). One session live at a time server-wide (singleton `PairingService`); starting a new one implicitly drops the old one (kept as `superseded` so its own client gets a clear "replaced" message rather than a bare 404).

**Discovery poll** (`pollOnce`, driven every **`POLL_INTERVAL_MS`=1000ms** externally): re-asks `adb mdns services`, matches a pairing hit by **exact** `service===PAIR_SVC && name===s.serviceName`; on hit, calls `adb pair <address> <password>`; on success parses the pair guid, re-queries mDNS for `CONNECT_SVC`, matches target by guid first then falling back to same-IP; if no connect service found → terminal `paired-not-connected` with message `'no connect service was advertised for this device'` (not a failure); else `adb connect <address>` — success → terminal `paired` (also triggers `ControlCenter.refreshNow()` if a tracker instance exists); failure → terminal `paired-not-connected` with message `'adb connect ... <adb's own text>'` [exact wording inferred …

**Pairing-code mode** (`startCode(address, code)`): skips `awaiting-scan`/mDNS discovery entirely — goes straight to `pairing` and calls `pairAndConnect` immediately against the typed address; never expires (no scan window).

**HTTP API** (`PairingApi.ts`, prefix `/api/devices/pair`, **must be registered before `DeviceDiscoveryApi`** or its routes silently 404; every route `requireAdmin`-gated, deliberately NOT loopback-restricted like `requireOperator` so remote-LAN admin use works without `WS_SCRCPY_ALLOW_REMOTE_ADMIN`):
- `POST /pair/qr` → `{sessionId, svg, expiresInMs}`.
- `POST /pair/code {address, code}` → validated by `isPairingAddress` (host:port, port required, bracketed IPv6 explicitly refused — `PairingService` can't derive a fallback IP from one) and `isPairingCode` (4–10 digits); 400 with field-specific message on failure; → `{sessionId}`.
- `GET /pair/status?sessionId=` → `PairingStatus` or 404 `{error:'no such pairing session'}` (also the signal for "cancelled/gone").
- `POST /pair/cancel {sessionId}` → idempotent, always `{ok:true}`.
- Errors logged as `name (+Node `code`)` only — message never logged (defense against leaking the secret through an unaudited error path).

**Client UI** (`renderPairingSection`, `NetworkDiscoveryPanel.ts:170-830`):
- Two mode toggle buttons ("scan QR code" / "pairing code") + Cancel.
- QR mode: renders server SVG via `innerHTML` (safe — SVG built only from a numeric module matrix, no payload interpolation); polls status every **1000ms** (`PAIR_POLL_INTERVAL_MS`); shows a live "stops working in about N seconds/minutes" countdown computed client-side from `expiresInMs` (duration, not absolute deadline — avoids clock-skew errors) while `awaiting-scan`.
- Code mode: address + code text inputs (code `inputmode=numeric`, `maxlength=10`); submit disabled until both non-empty.
- Status copy per state (`pairingStatusText`): `awaiting-scan` → "Scan this code on the phone: Wireless debugging → Pair device with QR code."; `pairing` → "Pairing…"; `connecting` → "Paired. Connecting…"; `paired` → "Paired and connected. The device appears in the list within a few seconds." (success styling); `paired-not-connected` → "Paired, but not connected yet — `<message>`." with a "connect"/"add it manually" action button; `expired` → "The pairing window closed. Start again to get a fresh code." + restart button; `failed` → server message or "Pairing failed." + restart button.
- Transport-failure tolerance: up to **3 consecutive** failed polls (`MAX_POLL_TRANSPORT_FAILURES`) before giving up with "Lost contact with the server while pairing."; any successful poll resets the counter.
- Cancel button shown only during `awaiting-scan` (after that, `adb pair` is already irrevocably in flight).
- On `paired-not-connected` with a known address, the action button does `POST /api/devices/connect {address, serial}` directly; without an address it opens the manual-add form with the port field forcibly cleared (no 5555 default) and a hint not to use the pairing dialog's port.
- 403 from any pairing route is rendered specifically as "Pairing needs an admin account. Ask an administrator to pair this device."

---

#### 11. Network Discovery Panel — overall layout (`NetworkDiscoveryPanel.ts`)

Header: "Available Network Devices" title + 3 buttons: **quick scan** (mDNS-only, no subnet needed, tooltip "mDNS-only — finds modern Android devices with wireless debugging enabled"), **scan network** (opens `ScanNetworkModal` after fetching detected/gateway subnet), **manually add** (toggles the manual-connect form). Below: manual-connect form (hidden by default), pairing section, results grid (`.discovery-grid` of `.discovery-card`s populated live from `scan.hit`), and an info/status box (default text: *"Click quick scan for modern Android devices on your network, or scan network to probe a full subnet. Make sure wireless debugging is enabled on the devices you wish to connect with."*).

Quick scan shows lightweight inline text ("scanning over mDNS…") instead of the `ScanProgressChip`; on completion with 0 hits shows *"No devices advertising over mDNS. Try scan network for a full subnet probe."*

Scan-card fields: top line = `hit.name || hit.model || ''` (hidden via CSS if empty), address line, optional pairing hint line *"may need pairing first — use "Pair a new device""* (shown only when `mayNeedPairing` is true — advisory only, connect stays enabled), name input pre-filled with any resolved label, connect button, dismiss ("close") button that only removes the card from view (no server call).

`ScanProgressChip` states/labels: `scanning` → "Scanning network · N / M · K found" (cancel button visible); `draining` → "Finishing active scans…"; `complete` → "Scan complete · N device(s) found" (auto-hide after 5s, dismiss × visible); `cancelled` → "Scan canceled · N device(s) found" (held visible for at least `MIN_DRAIN_DISPLAY_MS=1200` ms after drain started, then auto-hide after 10s). WS `close` before a terminal message → "Scan connection lost before completion."; WS `error` → "Scan connection failed."

`ScanNetworkModal`: lists detected/gateway subnet (non-removable, annotated "detected gateway subnet") plus user rows (removable, annotated "manually added", each editable/removable), displays total host count, a safety warning banner (*"⚠ Scanning sends connection attempts to every host on the selected subnet(s). On managed or corporate networks this may trigger intrusion-detection alerts. Only scan networks you own or administer."*), and a "subnet cheat sheet" help link. Start button disabled while total hosts = 0. In-container note (`CONTAINER_SCAN_NOTE`) always shown when `inContainer`, independent of row count.

`AddSubnetModal`: single text input, live validation via `parseSubnetInput` showing ✓/host-count or ✗/error text (with a clickable cheat-sheet link substituted into the parser's static error sentence); Enter submits when valid; supports `mode:'edit'` pre-filled from an existing row.

[Some lines truncated to 768 chars. Use agent://DeviceMgmtScout:raw:141-141 to read line 141 whole; cut lines run to line 168, each read the same way]


## B.4 Shell & file browser


#### 1. Dialog base class (`src/app/ui/Modal.ts`)

All modals (`ShellModal`, `ShellCloseConfirmModal`, `ListFilesModal`, etc.) extend abstract `Modal`, backed by a native `<dialog>` element (`.showModal()`), giving native top-layer rendering, focus trapping, and backdrop.

**Construction** (`Modal.ts:38-117`): builds `<dialog class="modal">` → `.modal-frame` → header (`.modal-title` + `.modal-header-controls` with theme toggle, optional subclass header buttons via `addHeaderButton()`, and an `×` close button unless `dismissible:false`) → `.modal-body` (filled by abstract `buildBody()`) → optional `.modal-footer` (from `buildFooter()`, default `null`).

**Dismiss hooks** — each has a default and is overridable:
- `onEscapeKey(event)` — default `this.close()`. Browser `cancel` event always `preventDefault()`'d first so the hook controls behavior.
- `onBackdropClick(event)` — default `this.close()`. Detected via `event.target === this.dialog` (padding:0 on `dialog.modal` is required for this to work).
- `onCloseButtonClick()` — default `this.close()`.
- `onBeforeClose()` — default no-op; subclasses override for teardown (sockets, terminals, observers).
- `ModalOptions.dismissible` (default `true`): when `false`, no `×` rendered and Escape/backdrop are ignored entirely (forced-choice dialog).

**Parent/child stacking** (`Modal.ts:141-183`): `openChild(open)` marks `Modal.openingParent` so any modal constructed during `open()` is auto-registered as this modal's child; children are closed when the parent closes (`closeChildren()`), in either direction. `askChild(ask, unanswered)` is `openChild` for a `Promise`-returning opener (e.g. a confirm dialog): if the parent began closing before the child's promise settles, the caller gets `unanswered` instead of the real answer — guards against acting on a stale confirm.

**`closeAfter(ms)`**: schedules `close()` after `ms`; any manual close before then cancels the timer. Used for auto-dismissing connection-error messages (4000ms in both `ShellModal` and `ListFilesModal`).

**`close(result?)`** (`Modal.ts:198-211`): idempotent (guarded by `this.closed`); calls `onBeforeClose()`, `dialog.close()`, removes the `<dialog>` from DOM after `transitionend` (200ms CSS) or a 250ms fallback timeout, then fires `options.onClose?.(result)`.

**CSS** (`src/style/modal.css`): base `.modal-frame` is `clamp(400px, 50vw, 700px)` wide, `max-height: 80vh`; entry/exit animated via `@starting-style` (opacity 0→1, `scale(0.96) translateY(8px)` → identity). A second stacked modal gets an opaque (non-glass) frame (`rgb(42,42,42)` dark / `rgb(245,248,252)` light) so nested content is crisp.

#### 2. Shell modal (`src/app/googDevice/client/ShellModal.ts`)

**Opening**: `DeviceTracker.ts:356-358` intercepts clicks on each device's "shell" link (`target` attribute removed, `preventDefault`), dynamically imports `ShellModal`, and constructs `new ShellModal(udid, deviceLabel, params)` where `params = { hostname?, port?, secure?, pathname? }` (used only for remote/multi-host setups; defaults to current origin).

**Gating**: shell link is visually disabled (`pointer-events:none`, `opacity:0.4`, `aria-disabled="true"`, `tabindex="-1"`) when `GET /api/capabilities` (`src/server/api/CapabilitiesApi.ts`) reports `{shell:false}` — i.e., `node-pty` failed to resolve server-side. Tooltip text varies by `shellReason`:
  - `'no-seed-package' | 'seed-stage-failed'` → *"shell unavailable — node-pty seed not staged. reinstall the app or check server logs."*
  - `'download-failed' | 'load-failed-after-download'` → *"shell unavailable — no node-pty prebuilt matches your Node version. update Node in the dependencies panel or wait for the next prebuild release."*
  - any other/unspecified → *"shell unavailable. see server logs for details."*
  Capabilities are cached in-memory (`capabilitiesCache`); a fetch failure defaults to `{shell:true}` (fail open — click-time WS failure surfaces the real error instead).

**Modal shell**: `dialog.classList.add('shell-modal')` → CSS sizing `clamp(500px, 90vw, 1600px)` wide, `max-height: 90vh`, `min-height: 600px`, black `.modal-body`, no padding. A `.shell-warning` div is inserted between header and body: *"resizing the browser window after starting a session may cause display issues."*

**Dismiss policy** (overrides, `ShellModal.ts:79-96`):
- Escape → no-op (reserved for terminal input).
- Backdrop click → no-op (protect session from accidental dismissal).
- `×` button → if shell hasn't started yet, closes immediately; otherwise opens `ShellCloseConfirmModal` as a child via `askChild(..., false)` — only closes if the user confirms.

**Transport**: shared root WebSocket per URL, cached in `ManagerClient.sockets: Map<url, Multiplexer>`. If none exists, opens `new WebSocket(url)`, wraps with `Multiplexer.wrap(ws)`; the multiplexer self-closes on `'empty'` (no channels left) once nothing references it. A dedicated channel is created with init data `ChannelCode.SHEL` (`'SHEL'`, ASCII, no length prefix — fixed 4-byte code). WS URL built by `buildMultiplexUrl()` (`src/app/googDevice/client/multiplexConnection.ts:38-55`):
  - Explicit `hostname`+`port`: validates hostname against `/^[A-Za-z0-9._-]+$/` or bracketed IPv6 `/^\[[0-9A-Fa-f:]+\]$/` (SSRF/injection guard — rejects `/ \ @ ? # :` and whitespace), port must be integer 1–65535; builds `ws(s)://host:port<pathname>`.
  - Otherwise: `ws(s)://<location.host><pathname ?? location.pathname>` (trusted same-origin).
  - Always appends `?action=multiplex` (`ACTION.MULTIPLEX`).

**Channel lifecycle / error reporting** (`ShellModal.ts:160-203`): tracks `opened`/`failed` flags so a failure before `'open'` fires is reported exactly once, even though the shared multiplexer broadcasts its error/close to every channel. On `'error'`, waits one tick (`setTimeout(…,0)`) for the paired `'close'` (which carries the code) before reporting. Message format: `` could not reach <hostname>:<port|443/80> (code <code>[: <reason>]) `` shown via `showConnectError()`: red (`#f06c75`) monospace text replacing `bodyEl`, auto-closes after 4000ms (`closeAfter(4000)`).

**Protocol** (`type MessageXtermClient`, JSON over the SHEL channel):
```
{ id: 1, type: 'shell', data: { type: 'start',  rows, cols, udid } }
{ id: 1, type: 'shell', data: { type: 'resize', rows, cols, udid } }
{ id: 1, type: 'shell', data: { type: 'stop',   udid } }
```
- On channel `'open'`: `initTerminal()` creates `new Terminal()` (xterm.js **defaults** — no custom font/theme/scrollback options set), loads `AttachAddon(this.ws)` (binds terminal I/O directly to the WS channel, raw bytes both directions) and `FitAddon`. `term.open(container)`.
- `ResizeObserver` on the terminal container: first fire with non-zero dimensions calls `fitAddon.fit()`, focuses the terminal, and sends `'start'` (computed `rows`/`cols` from `fitAddon.proposeDimensions()`, falling back to `24`×`80`); every subsequent fire sends `'resize'`.
- `onBeforeClose()`: if WS is open, sends `'stop'` then `ws.close()`; disposes `Terminal`; disconnects `ResizeObserver`.

**Server (`src/server/goog-device/mw/RemoteShell.ts`)**:
- Registered for channel code `SHEL` (`processChannel`) and also reachable over plain WS via `ACTION.SHELL` request param (`processRequest`) — full-page legacy path.
- On `'start'`: calls `createTerminal()` → `getNodePty()`; throws `node-pty not available: <reason>` if unresolved. Spawns `pty.spawn(Config.adbPath, ['-s', udid, 'shell'], { name:'xterm-256color', cols, rows, cwd: process.cwd(), env, encoding: null })`.
- **Env allowlist** (`buildShellEnv`, #29): only passes through a fixed allowlist from `process.env` (POSIX: `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TMPDIR, ANDROID_USER_HOME, ANDROID_SDK_HOME, ANDROID_ADB_SERVER_PORT, ANDROID_ADB_SERVER_SOCKET`); everything else is dropped. Always sets `TERM=xterm-256color`, `COLORTERM=truecolor`.
- PTY output is buffered and coalesced: binary mode (`USE_BINARY = os.platform() !== 'win32'`) buffers into a `Buffer[]` and flushes as one WS binary frame every 5ms (`bufferUtf8(5)`); string mode similarly concatenates strings and flushes every 5ms.
- `'resize'`: calls `term.resize(cols, rows)` if both present.
- `'stop'`: calls `release()` → clears timers, `term.kill()`.
- PTY `onExit`: close code `1000` on exit code 0, else `4500`; reason `"[RemoteShell] terminal process exited with code: <code>"`; deferred until any pending flush timers complete.
- Input: once initialized, any raw WS message is written verbatim to the PTY (`term.write(event.data)`) — this is standard keystroke passthrough (Escape, Ctrl sequences, etc. all pass through unmodified).

#### 3. Shell close confirmation (`src/app/client/ShellCloseConfirmModal.ts`)

Static `ShellCloseConfirmModal.confirm(): Promise<boolean>` — wraps construction in a `Promise`, resolved once via internal `settle()`/`resolveAndClose()` (idempotent, guarded by `resolved` flag).
- Title: *"End Shell Session"*. Body (filled via `queueMicrotask` since field initializers run after `super()`): *"ending the shell session loses any active work in the shell."* / *"close anyway?"*.
- Footer: **cancel** button → resolves `false`; **close** button → resolves `true`.
- Escape, backdrop click, `×` button → all resolve `false` (safe default: keep session).
- `onBeforeClose()` (fires if parent `ShellModal` closes some other way first, e.g. a timed error-close) → settles `false` if not already settled, so nothing awaits forever; the caller (via `askChild`) additionally receives `unanswered=false` if the parent had already begun closing.

#### 4. List Files modal (`src/app/googDevice/client/ListFilesModal.ts`)

**Opening**: `DeviceTracker.ts:371-381` intercepts "list files" links the same way as shell, dynamically imports and constructs `new ListFilesModal(udid, deviceLabel, params)`. No capability gating (file browsing has no node-pty dependency).

**Modal shell**: `dialog.classList.add('list-files-modal')` → CSS `clamp(500px, 70vw, 900px)` wide, `max-height: 85vh`. Header gets an extra `[⊞]` button (left of `×`, tooltip *"icon size preference"*) that reopens the size picker.

**Icon-size preference** (first-run picker, `ListFilesModal.ts:112-135, 364-427`):
- Reads `SettingsService.getGlobalCached()['iconSize']` (server-persisted per-user setting, not `localStorage` despite the design doc's claim — code is authoritative). Treated as "set" only if a positive number; `0` is the in-band sentinel for "no preference" (valid sizes are 16–32, so 0 is unambiguous).
- If unset: shows size picker instead of file list. Five options — **16, 20, 24, 28, 32px** — each with a live-sized folder-icon preview.
- Checkbox "save preference (skip this dialog next time)"; if checked and unchecked later with "ok", server setting is explicitly cleared by writing `iconSize: 0` (there's no per-key delete endpoint).
- "ok" applies `--file-icon-size` CSS custom property on `this.dialog` and calls `initFileBrowser()`.
- Reopening the picker via `[⊞]` shows a note *"uncheck and click ok to clear saved preference"* when the checkbox is checked.

**Transport**: same `ManagerClient.sockets` shared-multiplexer pattern as `ShellModal`. Root channel init data for FSLS is built by `buildFslsInitData(serial)`: `ChannelCode.FSLS` ascii (4 bytes) + serial byte-length (u32 LE) + serial UTF-8 bytes. This FSLS channel is itself a sub-multiplexer; it is kept alive against the parent's auto-close-when-empty behavior via `attachFsChannelKeepAlive()` (registers a no-op `'empty'` listener, detached in `onBeforeClose`). Every LIST/STAT/RECV/SEND command opens its own **sub-channel on the FSLS channel**, closed when that command completes.

**Dismiss policy**: Escape, backdrop click, and `×` all route through `confirmClose()` — if `activeDownloads>0 || activeUploads>0`, shows a native `confirm('transfers in progress — close anyway?')`; otherwise closes immediately. `onBeforeClose()` releases the `FilePushHandler`, closes all tracked channels and the FSLS channel, and clears download/upload maps (no explicit server-side abort message is sent for a download/upload — closing the channel is the cancellation mechanism).

**Directory navigation protocol** — ADB sync protocol framed over multiplexer sub-channels (`Protocol` constants from `common/AdbProtocol`; code module `adbSyncReply.ts`):
- `loadDirectory(path)`: resets `entries`, `selectedPaths`, `filterText`/filter input, then sends `STAT` for `path`.
- Command payload format (`sendCommand`): `<4-byte ascii cmd><u32LE path-byte-length><path utf8 bytes>`, sent as sub-channel init data (not a message).
- Server (`src/server/goog-device/mw/FileListing.ts`): routes by the leading 4-byte command inside each new sub-channel's init data: `STAT`/`LIST`/`RECV` → parses the length-prefixed path, dispatches to `AdbUtils`; `SEND` → hands off to `FilePushReader` (upload).
- **STAT reply**: `AdbUtils.pipeStatToStream` runs `adb shell stat -c '%f %s %Y' <path> || stat -c '%a %s %Y' <path>` (handles both GNU/BusyBox stat formats; mode parsed as hex first, octal fallback), sends `STAT`(4) + mode/size/mtime (3×u32LE) then closes channel code 1000. If `mode===0` client-side (entity truly missing), client falls back to `/data/local/tmp`. On success client dispatches: directory → `LIST`; regular file → `RECV` (download). Non-dir/non-file modes (symlink, device, etc.) are silently dropped (no handling branch).
- **LIST reply**: `AdbUtils.pipeReadDirToStream` runs `ls -1a <path>` for names, then **stats each entry individually** (`stat -c ...`) to get mode/size/mtime; if that fails, falls back to `ls -lad <entry> 2>/dev/null` and infers directory (`0o40755`) vs regular file (`0o100644`) from the leading `d`. Sends one `DENT` frame per entry: `DENT`(4) + mode/size/mtime(3×u32LE) + namelen(u32LE) + name bytes. No terminal `DONE` for LIST — client treats the sub-channel **close** as "listing complete" (`onClose` handler checks `dl.cmd === Protocol.LIST`). Client additionally skips `.` and `..` entries defensively even though the `ls -1a` output includes them and the server does not filter them.
- **RECV (download) reply**: `AdbUtils.pipePullFileToStream` runs `adb -s <serial> exec-out "cat <path>"` (not the ADB sync pull — generic cat; `maxBuffer: 50MB`), streams the whole buffered output back in `DATA` frames of 64KB (`DATA`(4) + chunk), then one `DONE`(4) frame, then closes. **50MB hard cap** — files larger than that fail download (execFile `maxBuffer` exceeded → rejected promise → `FAIL` sent instead).
- **FAIL reply**: `FAIL`(4) + msglen(u32LE) + utf8 message; sent by server on any caught error in the STAT/LIST/RECV handlers or by `FileListing.sendError` for an unrecognized command code; client only logs it to console (no user-visible error surfaced for FAIL on the file-listing path — `ListFilesModal.ts` `case Protocol.FAIL` just does `console.error`).
- Path resolution for rows: `resolve(currentPath, entry.name)` (absolute pass-through, `.`/`..` handled, else joined).

**Breadcrumbs** (`renderBreadcrumbs`): root `/` segment always first and clickable (jumps to `/`); each intermediate path segment is a clickable pill that calls `loadDirectory(targetPath)`; the last segment (current dir) is plain text. A filter `<input placeholder="filter...">` sits at the right end of the same bar.

**Filtering & sorting** (`applyFilterAndSort`): filter is client-side, substring match on `name.toLowerCase()` only (no size/date filtering), reset to `''` on every `loadDirectory`. Sort fields: `name` (default, ascending, locale compare), `size` (numeric), `date` (`mtime.getTime()`); directories are *always* sorted before files regardless of active sort field/direction; clicking a header toggles asc/desc if already the active field, else switches field and resets to ascending; sort resets to `name`/`asc` on every directory navigation; a ▲/▼ arrow (`▲`=asc, `▼`=desc) is appended to the active header.

**Icons** (`FileIconUtils.ts`) — `FileIconType = 'folder'|'file'|'image'|'video'|'audio'|'text'`, each inline 24×24 SVG + fixed color:
| Type | Color | Extensions |
|---|---|---|
| folder | `#5b9aff` | any directory |
| image | `#4ade80` | jpg jpeg png gif bmp webp svg |
| video | `#f97316` | mp4 mkv avi mov webm 3gp |
| audio | `#c084fc` | mp3 ogg flac aac wav m4a opus |
| text | `rgba(255,255,255,0.5)` | txt md json xml yaml yml log conf sh py js ts html css csv |
| file | `rgba(255,255,255,0.5)` | anything else (unknown extension / no extension) |

Lookup is a flat extension→type map on the lowercased final extension; symlinks get `.file-icon-symlink` CSS class added (small overlay) but `getFileIconType` does **not** actually resolve the symlink's target type — `isSymlink` parameter is accepted but ignored in the type decision (only used for the CSS class). Mode bits come straight from `Stats` (`src/app/googDevice/Stats.ts`): standard POSIX `S_IF*` constants; `isSymbolicLink()` checks `mode & S_IFMT === S_IFLNK` — but since STAT/LIST never special-case symlinks server-side beyond raw `stat`/`ls` output, a symlink's mode as reported by `stat -c '%f'`/`%a` determines this.

**Row UI** (`createFileRow`): checkbox, icon, name, reserved-width hover actions column (download `[↓]` button shown only for files; delete `[×]` button shown for all), right-aligned size (blank for directories) via `formatSize` (`B`/`KB` @1 decimal <1MB/`MB` @1 decimal <1GB/`GB` @1 decimal), right-aligned date via `formatDate` (`"mon dd yy"`, e.g. `apr 16 26`). Clicking a directory row navigates into it; clicking a file row does nothing (must use checkbox or hover actions). Row `data-path` attribute holds the resolved absolute path (used by `CSS.escape()`-guarded selector lookups for progress-bar updates).

**Selection**: `Set<string>` of absolute paths. Header checkbox: checked = all visible selected, `indeterminate` = some-but-not-all selected; toggling it selects/deselects every currently-filtered/visible entry. Footer button enable rules (`updateFooterState`):
- **Delete**: enabled iff `selectedPaths.size > 0` (works on files and directories).
- **Download**: enabled iff selection non-empty **and no selected entry is a directory** (bulk/recursive directory download is not supported — ADB doesn't make it cheap).
- **Upload**: always enabled, independent of selection; always uploads to `currentPath`.
Footer info text: `"<n> selected / <m> items"` when something's selected, else `"<m> items"` (`m` = filtered/visible count, not raw server count).

**Download** (single via row `[↓]`, or bulk via footer button iterating all selected files): `downloadFile()` increments `activeDownloads`, sends `RECV`; `DATA` frames fill a `.list-files-progress` bar (width = `receivedBytes*100/entry.size`, inserted into the row lazily); on `DONE`, `finishFileDownload()` builds an in-memory `File` from accumulated `Uint8Array` chunks, creates an `<a download>` anchor with an `Object URL`, `.click()`s it (triggers the browser's native save flow), then revokes the URL. **No zip packaging** — bulk download issues one `RECV` per file, sequentially queued but concurrently in flight (no explicit serialization is enforced in the client code beyond each being a separate channel).

**Upload**:
- Entry points: footer "upload" button → hidden `<input type="file" multiple>` click; or native HTML5 drag-and-drop onto the modal body (`DragAndDropHandler` + `FilePushHandler` wiring via `onDragEnter/onDragLeave/onDrop`) which shows a `.list-files-dropzone` overlay (`"drop files here"`) while files are dragged over (`enterCount` tracks nested drag-enter/leave to avoid flicker from child elements).
- Protocol (`CommandControlMessage` push-file states `NEW → START → APPEND (repeated) → FINISH`, binary-framed, over `SEND`-coded sub-channels created per file): client requests a `NEW` push id, server (`FilePushReader`) issues a `NEW_PUSH_ID` response; client sends `START` with destination filename (`join(currentPath, file.name)`) and size; server validates destination via `assertSafeRemotePath` (rejects empty/NUL/leading-`-` names — adb-argv-injection guard) and opens a temp file (`os.tmpdir()/adb_push_<id>_<timestamp>`); client streams the browser `File`'s `ReadableStream` in chunks via repeated `APPEND`; `FINISH` closes the temp write stream and runs `adb push <tempfile> <destPath>` (so an upload to an existing path **overwrites it** — no conflict dialog…
- UI: each in-flight upload gets a synthetic row (`id="upload-<fileName>"`) inserted at the top of the rows container, generic-file icon, text `"<fileName>: <message>"` (message mirrors protocol phase: `"begins..."` → `"NN.NN%"` → `"success!"`), animated progress bar. On error (any non-zero response code or a stream error), the row turns red (`.error` class), shows `"<fileName>: error: \"<decoded code message>\""`, and auto-removes after 2000ms (`REMOVE_ROW_TIMEOUT`) followed by a directory reload. On success (`finished && !error`), the row is removed and a directory reload is scheduled (debounced 500ms so simultaneous multi-file completions trigger one reload, not N).
- `isAllowedFile()` on `AdbkitFilePushStream` always returns `true` — no client-side MIME/extension restriction.

**Delete**:
- Single: row hover `[×]` → `confirm('delete "<name>"?')` → `deleteFiles([path])`.
- Bulk: footer "delete" → `confirm('delete <n> item(s)?')` → `deleteFiles(selectedPaths)`.
- **Not** over the FSLS WS channel — a separate REST call: `POST /api/devices/files/delete` with body `{ udid, paths: string[] }` (`src/server/api/DeviceDiscoveryApi.ts:305-331`).
- Server validation (`assertDeletablePaths`, `src/server/security/deviceInput.ts:103-127`): `paths` must be a non-empty array, ≤1000 entries (else `400`); every path must be a non-empty string, contain no NUL, start with `/`, contain no `.`/`..` path segments; after stripping trailing slashes, must not equal a protected root: `/`, `/sdcard`, `/storage`, `/storage/emulated`, `/storage/emulated/0`, `/data`, `/system`, `/vendor`, `/mnt`, `/proc`, `/dev` — any violation returns `400 {error:"<message>"}` before any device call is made.
- Execution: server runs `adb -s <udid> shell rm -rf <shArg(path)>` sequentially per path (quoted via `shArg`: wraps in `'...'`, escapes embedded `'` as `'\''`), collecting `{path, error}` for any that throw.
- Response shapes: all succeed → `200 {success:true}`; some fail → `207 {success:false, errors:[{path,error}]}`; validation refusal → `400 {error:"..."}` (never reaches `adb`).
- Client-side formatting (`deleteResult.ts` `describeDeleteResponse`): a `207` prints `` delete failed: <path0>: <error0> (+N more) `` in the footer (overwriting the selection-count text for 10 seconds, then reverting via `setTimeout`); a non-2xx with `{error}` prints `` delete failed: <error> `` or `` delete failed: HTTP <status> `` if no message; a network/parse exception prints `"delete request failed"`. After any delete attempt (success or failure), the client unconditionally reloads the current directory (`loadDirectory(currentPath)`).

#### 5. Known gaps / inconsistencies vs. design docs `[unverified→resolved by code]`
- The list-files design doc proposes `localStorage` for icon-size persistence; the implemented code uses server-side `SettingsService` (`patchGlobal`), not `localStorage`.
- The design doc's delete section matches the shipped REST endpoint exactly (method, path, body, response shapes, `rm -rf`).
- LIST never emits a `DONE` sentinel in the live implementation (only STAT and RECV do); completion is detected by sub-channel close.
- Symlink target-type resolution for icons is not implemented — `_isSymlink` parameter to `getFileIconType` is unused for type selection.

[Some lines truncated to 768 chars. Use agent://ToolsScout:raw:133-133 to read line 133 whole]


## B.5 HTTP/WS API, security, persistence


ws-scrcpy-web's server is a hand-rolled `http(s)`/`ws` stack (no Express/Fastify): `src/server/index.ts` wires a chain of API handler objects (each with `handle(req,res): Promise<boolean>`) onto `HttpServer`, plus a WebSocket upgrade path with its own Origin/Host/token gate and a session-aware per-socket registry. Security is layered: Host allowlist → Origin match → per-instance bearer token → (locked mode) session cookie via `AuthGate` → per-route role checks (`requireAdmin`/`requireOperator`) → container-mode refusals. Persistence is SQLite (`node:sqlite`) with 3 migrations, plus a flat `config.json` for boot-time/host-only settings. Below is the exhaustive route/protocol/security inventory.

### Files

- `src/server/index.ts` — composition root: registers all API handlers in order (order is load-bearing for `PairingApi`/`DeviceDiscoveryApi` and `SettingsApi`/`SettingsBatchApi`), starts `HttpServer`+`WebSocketServer`, wires WS `Mw` factories, signal/shutdown handling.
- `src/server/services/HttpServer.ts` — single request handler: security headers → plain-HTTP exposure gate → `evaluateHttpRequest` (Host/Origin/token) → API handler chain → static fallback.
- `src/server/services/WebSocketServer.ts` — WS upgrade: `verifyClient` origin/token gate, per-connection session resolution (`wsSession`), `liveSockets` registry, path-handler vs. action-based `Mw` dispatch.
- `src/server/security/{originGuard,requestGate,instanceToken,cookiePolicy,frameGuard,loopback,forwardedProto}.ts` — CSRF/DNS-rebinding/token/cookie/CSP machinery.
- `src/server/auth/{AuthGate,authState,requireOperator,requireAdmin,session,loginService,loginPolicy,password,lockdown,currentUser,socketRegistry}.ts` — login/session/role system.
- `src/server/api/*.ts` — 16 route handlers + shared helpers (`utils.ts`, `containerGuard.ts`, `portCollision.ts`, `restartRequest.ts`, `systemServicePortGuard.ts`, `pendingLabels.ts`, `deviceObserved.ts`).
- `src/server/db/{Db,UserStore,DeviceStore,AppSettingsStore,UserSettingsStore,PendingSettingsStore,constants,migrations,migrations/*}.ts` — SQLite schema/access.
- `src/server/Config.ts`, `src/common/ConfigEvents.ts` — config.json + `AppConfig` schema/defaults/validation.
- `src/server/Logger.ts` — log format + rotation.
- `src/server/reconcileWebPort.ts`, `src/server/PortPicker.ts`, `src/server/EnvName.ts` — port auto-shift, env var names.
- `src/server/StaticFileServer.ts` — SPA/static asset serving.
- `src/common/Action.ts`, `src/common/ScanMessage.ts` — WS action/path protocol constants.

### Architecture

Every HTTP request passes through one function (`createHttpRequestHandler`): sets `X-Content-Type-Options`/`X-Frame-Options`(/CSP) → honours plain-HTTP exposure mode (`open`/`httpsOnly`/`redirect`, loopback-exempt) → `evaluateHttpRequest` (Host allowlist, Origin match on sensitive paths, per-instance token on `/api/*`, token-cookie issuance on document GETs) → iterates registered `ApiHandler`s in registration order (first `true` wins) → static/SPA fallback. `AuthGate` is the *first* API handler; in open mode it's a no-op, in locked mode it resolves the session cookie, allowlists a handful of paths, and otherwise serves an inline login page (HTML) or 401 JSON. Downstream handlers call `requireOperator`/`requireAdmin`/`refuseInContainer` themselves — there's n…

### Report

#### 1. Authentication & session model

- **Modes**: "open" (default, `app_settings.authEnabled=false`) — every request/socket resolves to the **implicit admin** (`IMPLICIT_ADMIN_ID = 1`, role `admin`), no login required. "Locked" (`authEnabled=true`) — `AuthGate` enforces session cookies on everything not allow-listed.
- **Allowlisted paths under lockdown** (`src/server/auth/authState.ts:16-33`): exact `/api/auth/login`, `/api/auth/me`, `/api/whoami`, `/api/server/shutdown`, `/embed-request`; prefix `/embed-request/`. These are *never blocked* by AuthGate but a valid session cookie is still attached to `req.user` if present.
- **Password hashing** (`auth/password.ts`): `scrypt` with `N=16384, r=8, p=1`, 64-byte output; stored as `scrypt$N$r$p$<salt_b64>$<hash_b64>`. Verification is constant-time (`timingSafeEqual`). `blindVerify()` runs a dummy scrypt against unknown/disabled/locked users to defeat username-enumeration timing.
- **Lockout policy** (`auth/loginPolicy.ts`): `MAX_FAILS=5` within a `WINDOW_MS=5min` sliding window → `LOCK_MS=15min` lock; a login attempt while locked extends the lock (resets inactivity timer) and still runs `blindVerify`.
- **Session cookie** `wsscrcpy_sid` (`SESSION_COOKIE`): `HttpOnly; SameSite=Lax` (relaxes to `None; Secure; Partitioned` only when `frameAncestors` is configured **and** request is HTTPS, per `cookiePolicy.ts`); `Path=/`. 30-day sliding TTL (`SESSION_TTL_MS`), extended on every `findValid()` call. Server-side: `sessions` table stores only `SHA-256(token)`, never the raw token.
- **Instance token cookie** `ws_scrcpy_token` (`security/instanceToken.ts`): 32 random bytes hex, generated once per process (`getInstanceToken`), `HttpOnly; Path=/; SameSite=Strict` (relaxes like the session cookie). Required (`requiresToken`) on all of `/api/*` and every WS handshake **except**: `GET/HEAD /api/config`, `GET /api/whoami`, `POST /api/server/shutdown`, `GET /api/tls/ca-root`, `GET /api/updates/status`. Attached (`shouldSetTokenCookie`) only on GET/HEAD document responses (extensionless path or `.html`), never on `/api/*` or asset responses.
- **Login**: `POST /api/auth/login` `{username,password}` → 200 `{ok:true}` + session cookie, or 401 `{ok:false, reason: 'invalid'|'disabled'|'locked'}`.
- **Logout**: `POST /api/auth/logout` → deletes the session row and calls `liveSockets.revokeSession(token)` (closes all WS sockets opened under that session with code 4401), clears cookie with identical attributes used to set it.
- **`GET /api/auth/me`**: self-check, never blocked by AuthGate. Returns `{authEnabled, needsLockdown, user:{username,role}|null}`. `needsLockdown = countEnabledAdminsWithPassword()===0`.
- **`POST /api/auth/change-password`** `{currentPassword,newPassword}`: 400 if `newPassword` empty or current wrong; 200 `{ok:true}`.
- **`POST /api/auth/enable`** (requireOperator): 409 if no admin has a password set yet; else sets `authEnabled=true`.
- **`POST /api/auth/disable`** (requireOperator): sets `authEnabled=false`.
- **First-user "lockdown"** (`auth/lockdown.ts`, reached via `POST /api/users` when `needsLockdown`): atomically renames the implicit admin, sets its password, creates the requested new user, and flips `authEnabled=true` in one SQLite transaction.
- **Roles**: `'user' | 'admin'` (CHECK constraint). `requireAdmin` = acting user's role is `admin` (403 `{error:'forbidden'}` otherwise). `requireOperator` = `requireAdmin` **plus** proof of being "the operator": loopback caller, OR (locked mode) an authenticated session, OR (open mode) `allowRemoteAdmin()` true (config.json `allowRemoteAdmin:true` or env `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1`). Off-box+open-mode+no-opt-out → 403 `OPERATOR_REFUSAL_ERROR`.
- **`resolveUserId(req)`**: `req.user.id` if `AuthGate` attached one, else `IMPLICIT_ADMIN_ID` — this is how open mode becomes "implicit admin" everywhere.

#### 2. Security layers (HTTP)

- **Host allowlist** (`originGuard.isHostAllowed`): hostname (port stripped) must be `localhost`, any IP literal, or one of `setAllowedHosts()` (from config.json `allowedHosts`, empty by default). Any other Host → 403 `host not allowed (possible DNS rebinding)`.
- **Origin check** (`isRequestAllowed`, applied when `requiresOriginCheck`: true for all `/api/*` and any non-GET/HEAD method anywhere): if an `Origin` header is present it must equal `http://<host>` or `https://<host>` (case-insensitive); missing Origin is allowed at this layer (non-browser/same-origin GETs omit it) — closed by the instance token instead.
- **Plain-HTTP exposure modes** (`tls/httpExposure.ts`, `HttpServer.ts`), persisted at `app_settings['httpExposure']`, default `'open'`: `'open'` — serve normally; `'httpsOnly'` — 421 Misdirected Request (unless caller is loopback or no HTTPS listener exists); `'redirect'` — 302 to `https://<host>:<httpsPort>` with `Cache-Control: no-store` (falls through to plain HTTP if the Host wouldn't itself be allowed, to avoid building an open-redirect Location from an attacker Host). Only governs the **plain** listener.
- **`X-Forwarded-Proto` trust** (`forwardedProto.isRequestSecure`): only honoured when the TCP peer is loopback (the documented reverse-proxy-on-localhost deployment); otherwise ignored. Drives whether `Secure`/`SameSite=None`/`Partitioned` cookie attributes may be set.
- **Security headers on every response** (`frameGuard.securityHeaders`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, plus `Content-Security-Policy: frame-ancestors 'self' <origins>` when `frameAncestors` is non-empty (config.json, or approved via the embed-consent flow). `X-Frame-Options` stays `SAMEORIGIN` unconditionally for back-compat with CSP-ignorant browsers.
- **Embedding consent flow** (`EmbedRequestApi`, `security/embedRequests.ts`): `POST /embed-request {origin,appName}` (loopback-only, ungated by token/auth) creates a pending request → polled via `GET /embed-request/:id` or cancelled `POST /embed-request/:id/cancel`; an admin at the local machine reviews via `GET /api/embed-request` and decides `POST /api/embed-request/decision {id, approved}` (admin **and** loopback via `requireLocalAdmin`) → approval calls `Config.addFrameAncestor(origin)`, persisted to config.json and live `setFrameAncestors`. `GET /api/embed-origins` / `POST /api/embed-origins/revoke {origin}` manage the list (admin+loopback).
- **Request body cap**: 1 MiB (`MAX_BODY_BYTES`) on every JSON body reader; overflow → 413 (or silently `{}` for the lenient `readJsonBody`).
- **Container guard** (`containerGuard.ts`): `Config.getInstance().dockerMode` (env `WS_SCRCPY_DOCKER=1`) makes host-lifecycle routes answer 409 `{ok:false,error,reason:'unsupported'}` — service install/uninstall, dependency update/check/restart/retry-install, update check/apply/config, TLS routes (reads and writes), and config writes to host-only keys (`installMode`,`firstRunComplete`,`webPort`,`autoUpdate`,`updateCheckIntervalMinutes`,`channel`,`githubOwner`).

#### 3. WebSocket surface

- **Handshake gate** (`WebSocketServer.attachToServer`, `verifyClient`): `evaluateWsConnection(origin, host, cookie)` — Host/Origin match (same rule as HTTP) **and** instance-token cookie required, unconditionally (no exemptions for WS). Rejection → `cb(false, 403, 'Forbidden')`, logged (rate-limited via `RejectionLogLimiter`, keyed per remote-address+reason, one summary line per window).
- **Post-handshake auth** (`wsSession`): open mode → `{userId: IMPLICIT_ADMIN_ID}` always. Locked mode → session cookie must resolve to a non-disabled user via `SessionStore.findValid`; missing/invalid/disabled → socket closed with code **4401** `'unauthorized'`. The resolved `token` (only set in locked mode) is what a later logout/disable can revoke via `liveSockets.revokeSession`/`revokeUser` (close code 4401).
- **Routing**: by exact `url.pathname` registered path handler first (only one today: `SCAN_WS_PATH = '/ws-scan'` → `ScanMw.attach`), else by `?action=` query param dispatched through every registered `MwFactory.processRequest(ws, {action, request, url})`; first factory returning a `Mw` instance wins. No match → close code **4002** `'Unsupported request'`. No URL at all → close code **4001** `'Invalid url'`.
- **Action enum** (`src/common/Action.ts`): `LIST_HOSTS='list-hosts'`, `GOOG_DEVICE_LIST='goog-device-list'`, `MULTIPLEX='multiplex'`, `SHELL='shell'`, `STREAM_SCRCPY='stream'`, `FILE_LISTING='list-files'`, `PROBE_DEVICE='probe'`. These map to `Mw` subclasses (`HostTracker`, `DeviceTracker`, `WebsocketMultiplexer`, `RemoteShell`, `ScrcpyConnection`, `FileListing`, `DeviceProbe`) registered in `index.ts`'s `mwList`/`mw2List`.
- **Message framing** (`Mw` base class): every outbound message is `JSON.stringify({id, type, data})` sent only while `readyState === OPEN`; inbound dispatch is per-subclass `onSocketMessage`. A `Multiplexer` channel (binary sub-protocol, `ChannelCode` 4-byte codes) layers a second dispatch inside `processChannel(ws, code, data?)` for `goog-device` features (shell, file listing, device tracking) tunnelled over one multiplexed socket.
- **Stream-session close codes** (`ScrcpyConnection.ts`): normal end = no code (browser sees 1005, treated clean); server shutdown = **1001** `SHUTDOWN_CLOSE_REASON`; failed start/mid-stream failure = **4005** `SESSION_FAILED_CLOSE_CODE` with the failure reason in the close frame text.

#### 4. HTTP API inventory

All responses `application/json` unless noted. "Auth" column: **public**=no gate beyond Host/Origin/token; **loopback**=machine-only; **operator**=`requireOperator`; **admin**=`requireAdmin`; **admin+loopback**=`requireAdmin` + machine-only.

| Method & Path | Auth | Body | Response / notes |
|---|---|---|---|
| `POST /api/auth/login` | public | `{username,password}` | 200 `{ok:true}`+cookie / 401 `{ok:false,reason}` |
| `POST /api/auth/logout` | public (allowlisted) | — | 200 `{ok:true}`, clears cookie, revokes live sockets |
| `GET /api/auth/me` | public (allowlisted) | — | `{authEnabled,needsLockdown,user}` |
| `POST /api/auth/change-password` | session user | `{currentPassword,newPassword}` | 200/400 |
| `POST /api/auth/enable` | operator | — | 200 / 409 if no admin password set |
| `POST /api/auth/disable` | operator | — | 200 |
| `GET /api/users` | operator | — | `{users:[...]}` (id,username,role,hasPassword,disabled,lockedUntil,lastLogin) |
| `POST /api/users` | operator | `{username,password,role?}` (+`adminUsername`/`adminPassword` if lockdown) | 201, or 400/409 |
| `PATCH /api/users/:id` | operator | `{role?,password?,disabled?,unlock?}` | 200/400/404/409 (guards last enabled admin) |
| `DELETE /api/users/:id` | operator | — | 200/400/404/409 (guards last enabled admin); sessions cascade |
| `GET /api/whoami` | loopback (token/auth exempt) | — | `{app:'ws-scrcpy-web',pid,installMode,version}` |
| `GET /api/capabilities` | public | — | `{shell:boolean, shellReason?}` |
| `GET /api/config` | public (token exempt) | — | `{config:AppConfig, runtime:FirstRunStatus+...}` |
| `PATCH /api/config` | operator | partial `AppConfig` | 200 `{config,restartRequired,redirectPort?}` / 400/409/413 |
| `GET /api/dependencies` | public | — | dependency list |
| `POST /api/dependencies/check` | public (container-refused) | — | triggers check |
| `POST /api/dependencies/:name/update` | public (container-refused) | — | |
| `POST /api/dependencies/restart` | public | — | 200, schedules restart |
| `POST /api/dependencies/retry-install` | public | — | |
| `POST /api/devices/scan` | public | — | mDNS-discovered connectable devices |
| `GET /api/devices/scan/subnet` | public | — | `{container:true}` in docker, else detected subnet |
| `POST /api/devices/connect` | public | `{address,serial?,label?}` | 200/500 `{success,message}`; validates `address` (no `-` prefix) |
| `POST /api/devices/disconnect` | public | `{address}` | 200 (incl. "not connected" treated success) |
| `GET /api/devices/screen-state?udid=` | public | — | `{..., locked}` |
| `POST /api/devices/sleep-wake` | public | `{udid,action}` | `{awake}` |
| `GET /api/devices/labels` | public | — | `{serial:label}` map |
| `PUT /api/devices/labels` | public | `{serial,label}` | 200; propagates to MAC-linked row |
| `POST /api/devices/files/delete` | public | `{udid,paths}` | (validated paths, see `security/deviceInput.ts`) |
| `POST /api/devices/pair/qr` | admin (not loopback-required) | — | `{sessionId,svg,expiresInMs}` |
| `POST /api/devices/pair/code` | admin | `{address,code}` | `{sessionId}` / 400 |
| `GET /api/devices/pair/status?sessionId=` | admin | — | session status / 404 |
| `POST /api/devices/pair/cancel` | admin | `{sessionId}` | `{ok:true}` |
| `GET /api/tls/state` | admin | — | cert/listener state, see §6 |
| `GET /api/tls/ca-root` | admin (token exempt) | — | PEM, rate-limited 10/60s |
| `POST /api/tls/generate` | operator | `{kind,value}` | |
| `POST /api/tls/revoke` | operator | — | |
| `POST /api/tls/exposure` | operator | `{mode}` | sets `httpExposure` |
| `POST /api/tls/https-port` | operator | `{port}` | may schedule restart |
| `GET /api/service/status` | operator | — | `ServiceStatusResponse` |
| `POST /api/service/install` | operator (container-refused) | — | |
| `POST /api/service/uninstall` | operator (container-refused) | — | |
| `POST /api/service/install-system-wide` | operator (container-refused) | — | |
| `POST /api/service/decline-system-wide` | operator (container-refused) | — | |
| `POST /api/service/uninstall-app` | operator (container-refused) | — | |
| `GET /api/settings` | per-user | — | `user_settings` for caller |
| `PATCH /api/settings` | per-user | arbitrary object | merges keys |
| `GET /api/settings/device?udid=` | per-user | — | `device_settings`, keyed by resolved serial; 503+Retry-After if serial not yet known |
| `PATCH /api/settings/device?udid=` | per-user | arbitrary object | ditto |
| `POST /api/settings/reset` | per-user | — | clears caller's settings+labels |
| `POST /api/settings/batch` | operator | staged changes (allowlist `STAGEABLE_IDS`) | write-ahead-logged via `pending_settings` |
| `POST /api/server/shutdown` | special ladder (see §1) | — | 200, exits after 100ms |
| `POST /api/server/restart` | operator | — | 200, writes `.restart` marker, exit 75 |
| `GET /api/updates/status` | public (degraded) / full w/ token | — | version-only without token |
| `POST /api/updates/check` | public (container-refused) | — | |
| `POST /api/updates/apply` | public (container-refused) | — | |
| `PATCH /api/updates/config` | public (container-refused) | partial updater config | |
| `POST /embed-request` | loopback | `{origin,appName}` | pending/400 |
| `GET /embed-request/:id` | loopback-adjacent (public GET) | — | status |
| `POST /embed-request/:id/cancel` | loopback | — | |
| `GET /api/embed-request` | admin+loopback | — | pending request |
| `POST /api/embed-request/decision` | admin+loopback | `{id,approved}` | 200/409 |
| `GET /api/embed-origins` | admin+loopback | — | `{origins}` |
| `POST /api/embed-origins/revoke` | admin+loopback | `{origin}` | 200/404 |

Error classes used throughout: 400 (bad input), 401 (AuthGate, unauthenticated), 403 (forbidden/host-origin/forbidden role), 404 (not found/no such resource), 409 (conflict — last-admin guard, container refusal, port collision, portCollision, remote-admin-forced), 413 (body too large), 421 (httpsOnly exposure misdirect), 500 (internal), 503 (serial not resolved yet, `Retry-After`).

#### 5. `config.json` schema (`FlatConfig`/`AppConfig`)

File-level (`FlatConfig`, read once at boot, `Config.ts:46-93`):
- `adbPath?`, `dependenciesPath?` — path overrides.
- `scanConcurrency?`, `scanTcpTimeoutMs?` (default 300), `scanAdbConnectTimeoutMs?` (default 5000), `scanProgressInterval?` (default 10).
- `server?: ServerItem[]` — advanced manual listener array (bypasses auto HTTPS generation).
- `webPort?` (default **8000**), `installMode?`, `firstRunComplete?`, `autoUpdate?` (default true), `updateCheckIntervalMinutes?` (default 60), `channel?` (`'stable'|'beta'`, default by build), `githubOwner?` (default `bilbospocketses`).
- `allowRemoteAdmin?` (default false) — **is** an `AppConfig` key, exposed via GET/PATCH `/api/config`.
- `allowedHosts?: string[]` — server-only, never exposed via `/api/config`.
- `frameAncestors?: string[]` — server-only, never exposed via `/api/config` (but exposed read-only via `/api/embed-origins` / `FirstRunStatus.frameAncestors`).
- `httpsPort?` (default **8443**, `DEFAULT_HTTPS_PORT`) — server-only.

`AppConfig` (the browser-visible/patchable subset, `src/common/ConfigEvents.ts:151-159`) = `installMode, firstRunComplete, autoUpdate, updateCheckIntervalMinutes, channel, githubOwner, webPort, dependenciesPath?, adbPath?, scanConcurrency?, scanTcpTimeoutMs?, scanAdbConnectTimeoutMs?, scanProgressInterval?, allowRemoteAdmin?`.

`GLOBAL_KEYS` (`db/constants.ts:17-27`) — these `AppConfig`/scan fields are actually persisted in SQLite `app_settings`, not config.json, once written through `updateAppConfig`: `autoUpdate, updateCheckIntervalMinutes, channel, githubOwner, adbPath, dependenciesPath, scanConcurrency, scanTcpTimeoutMs, scanAdbConnectTimeoutMs, scanProgressInterval`. Everything else in `AppConfig` (`webPort, installMode, firstRunComplete, allowRemoteAdmin`) stays in config.json. Precedence for the three "boot trio" fields and others follows: env var (where one exists, e.g. `WS_SCRCPY_WEB_PORT`) → SQLite `app_settings` (for `GLOBAL_KEYS`) → config.json value → hardcoded default (see `resolveConfig`-style helper at `Config.ts:1020-1027`, pattern `env ?? storeKey ?? fileValue ?? …

#### 6. SQLite schema (`wsscrcpy.db`, 3 migrations)

- `users(id PK, username UNIQUE NOCASE, role CHECK('user'|'admin'), password_hash, disabled, failed_attempts, lockout_window_start, locked_until, created_at, last_login_at)`. Seed row: `id=1 ('admin', role admin, password_hash NULL)` = the implicit admin.
- `sessions(token_hash PK, user_id FK→users ON DELETE CASCADE, created_at, expires_at, last_seen_at)`, indexed on `user_id`. Stores only the hash.
- `user_settings(user_id FK, key, value JSON, PK(user_id,key))`.
- `devices(serial PK, manufacturer, model, address, last_seen_at, mac [migration 003])`.
- `device_labels(user_id FK, serial, label, PK(user_id,serial))`.
- `device_settings(user_id FK, udid, scope, value JSON, PK(user_id,udid,scope))`.
- `app_settings(key PK, value JSON)` — seeded with `authEnabled='false'`.
- `pending_settings(id PK, user_id, created_at, status CHECK('pending'|'completed'|'failed'|'abandoned'), changes JSON, error)` [migration 002] — WAL for staged settings batches surviving a webPort-change restart (origin changes across the restart).

#### 7. Logging

Format: `Logger.for(tag)` → lines `"<ISO timestamp> [tag] <message>"` (warn/error append `WARN`/`ERROR` before the message). Written to file on every call via `fs.appendFileSync`; echoed to console only when `process.stdout/stderr.isTTY` is true (dev). File resolution order: `<DATA_ROOT>/logs/ws-scrcpy-web.log` → `<dirname(DEPS_PATH)>/logs/ws-scrcpy-web.log` → `<dist>/../ws-scrcpy-web.log` (dev fallback). Rotation: single backup, `MAX_LOG_SIZE = 10 MiB`; on every write, if current file ≥ cap, `renameSync(file, file+'.1')` (overwriting any prior `.1`). All fs errors swallowed.

#### 8. Port auto-shift rule (`reconcileWebPort.ts`)

Runs once at boot, before `HttpServer` starts, settling `servers[0].port`:
- `WS_SCRCPY_WEB_PORT` env, if set, forces that **exact** port (no walk) on every instance except the Linux system-service instance (which always uses config.json's `webPort` exactly and logs that it's ignoring the env var).
- No override, non-service instance: walk forward from configured `webPort` across `webPort..webPort+99` for a free port.
- If the configured port is busy and held by a **sibling instance** of this same app (detected via `GET /api/whoami` loopback probe) — the new port is used for this boot but **not persisted** to config.json (to avoid stomping the surviving instance's real port), except when this process itself is a service instance (handoff case), which always persists.
- If busy and held by anything else — the shift **is** persisted and `portWasAutoShifted:true` is reported.
- No free port found with an exact requirement → error logged, binds the busy port anyway (and fails), `setActualWebPort(..., persist:false)`.
- If the resolved port collides with a configured HTTPS entry at the same port, the HTTPS entry is dropped for this boot (HTTP wins) with a logged warning.

#### 9. Env vars read by the Node server (non-Windows-only)

`WS_SCRCPY_CONFIG` (config.json path override), `WS_SCRCPY_PATHNAME`, `DEPS_PATH`, `DATA_ROOT`, `WS_SCRCPY_WEB_PORT`, `WS_SCRCPY_DOCKER` (`'1'` → container mode), `WS_SCRCPY_ALLOW_REMOTE_ADMIN` (`'1'` forces `allowRemoteAdmin` on, overrides config.json), `WS_SCRCPY_NO_BROWSER`, `WS_SCRCPY_OPEN_BROWSER`, `WS_SCRCPY_LAUNCHER`, `WS_SCRCPY_SERVICE` (system-service identity, Linux), `SCAN_CONCURRENCY`, `NODE_DIST_BASE_ENV`/`MKCERT_URL_BASE_ENV`/`RELEASE_URL_BASE_ENV` (dependency/update download base-URL overrides), `SKIP_BOOT_LATEST_ENV` (dependency check skip at boot), `APPIMAGE` (Linux update-mode detection — not Windows-only). `[unverified]` exact string values of the `*_ENV` constants beyond what's quoted above since they're defined indirectly in `DependencyD…

[Some lines truncated to 768 chars. Use agent://ApiScout:raw:24-24 to read line 24 whole; cut lines run to line 181, each read the same way]


## B.6 Settings, dependencies, updates, Local HTTPS


### 1. Settings dialog shell

`SettingsModal.ts` builds a `<dialog>` with a `TabStrip` (`TabStrip.ts`) and up to 7 tabs: Users, Embedding, Updates, Service, Dependencies, Server, Local HTTPS. Every tab but Dependencies shares the DOM shape from `settingsLayout.ts`: `<section class="settings-section"><h3>Title</h3><div class="settings-card">…items…</div></section>`, each item = one `.settings-row` (label + control) plus notes, with a single status line (`buildTabAlert`) at the bottom of every tab (`success`/`error` auto-hide after 5s/10s via `TAB_ALERT_SUCCESS_MS`/`TAB_ALERT_ERROR_MS`; `busy` persists). Server and Local HTTPS are "split" tabs with multiple cards (`buildSplitSection`/`addCard`).

**Staged vs. immediate.** `StagedSettingsStore.ts` holds a `Map` of registered fields (`id, label, initial, format?, warning?`) and current values. `set()` only stages; `changes()` diffs current vs. `initial` (never formats the wire value — only display text, to avoid the historical bug where `autoUpdate` was sent as the string `'off'`); `commit()`/`commitField(id)` re-baseline after a successful save. `isDirty()` = `changes().length > 0`. Staged fields: `webPort`, `httpsPort` (Server), `channel`, `autoUpdate`, `updateCheckIntervalMinutes`, `githubOwner` (Updates), `frameAncestorsAdd` (Embedding's pending pre-approvals). Everything else (manage users, enable/disable login, install/uninstall service, generate/revoke cert, exposure mode, reset, restart, stop &…

**Close-with-unsaved.** `closeIntent(store)` (`closeIntent.ts`) returns `'prompt'` iff `store.isDirty()`, else `'close'`. On prompt, `SettingsDirtyCloseModal.choose()` offers `save | discard | cancel` (`DirtyCloseChoice`).

**Save flow** (`SaveRunner.ts` + `performStagedSave` in `SettingsModal.ts`): Save always shows `SettingsSummaryModal.confirm(changes)` first (never bypassable) → `runSave(changes)` POSTs the batch to `/api/settings/batch`, applying each non-`webPort` change one at a time and stopping at the first refusal (so a batch can partially land). On partial failure, `saveFailureMessage` reports `applied <labels>; couldn't save <label>: <error>` using the change's **label**, not its wire id. Changes the server reports as applied before the failure are committed individually via `commitField` (`COMMIT_WHEN_APPLIED`), today only for `frameAncestorsAdd`. A `webPort`/`httpsPort` change restarts the server; the summary adds a specific "page will reload" (`webPort`) or "stre…

**Admin/container gating.** Every admin-only tab checks `adminApiReachable(env.runtime)`/`canSeeSection(role, section)`; if refused the tab's controls are hidden (not merely disabled, since 0.5.8) behind `ADMIN_UNREACHABLE_NOTE`. In a container (`runtime.docker === true`), Service, Updates and Dependencies tabs are replaced wholesale with fixed copy (`buildDockerServiceNote`, `buildDockerUpdatesNote`, `buildDockerDependenciesNote` — `SettingsModal.ts:95-180`): *"service install not applicable — this instance runs in a container."* / *"app updates not applicable — this instance runs in a container; pull a newer image to update."* / *"dependency updates not applicable — this instance runs in a container; pull a newer image to update."* These exact strings are …

### 2. Users tab (`UsersTab.ts`)

- **Manage users** button → opens `UsersModal` as a child dialog (action).
- **Login toggle**: "disable login (return to open mode)" (`authClient.disableAuth()`) or "enable login" (`authClient.enableAuth()`); 409 on enable → *"Add a user with an admin password first (Users → manage users)"*. Reloads the page on success.
- **Remote admin without sign-in** (`REMOTE_ADMIN_ID`, staged, label *"Remote admin without sign-in"*). Checking it when currently off opens `RemoteAdminWarningModal` first; only an explicit accept stages `true`. Notes, by precedence: forced by env var → `REMOTE_ADMIN_FORCED_MESSAGE` (checkbox disabled); sign-in on → *"ignored while sign-in is on; it applies again if sign-in is turned off."*; this device is admin only because of it and is staging it off → *"you are on another device: saving this ends your admin access from here."* (also surfaced on the review screen as a `warning`); checked → *"any device that can reach this server can administer it. set up sign-in, or uncheck this, to close it."*; unchecked → *"admin actions are limited to this machine unle…

**UsersModal** (`UsersModal.ts`): list of users with role `<select>` (user/admin, PATCH on change), **disable** checkbox (PATCH `disabled`), **unlock** button (shown only if `lockedUntil > now`), inline **reset password** (PATCH `password`, with a 👁 show/hide toggle), **delete** (DELETE; 409 → *"Cannot delete: HTTP 409 (last admin)"*, keeps the error visible without refreshing). **Add user** opens a lockdown-aware form (`needsLockdown = me.needsLockdown ?? !me.authEnabled`): when lockdown applies, an extra "Secure the admin account" section collects the admin's own current username/password alongside the new user.

### 3. Embedding tab (`EmbeddingTab.ts`)

Lists approved embedder origins from `GET /api/embed-origins` (admin-local only; 403 → held back, no retry) each with a **revoke** button (immediate POST, confirmed). Below: an **add row** staging `frameAncestorsAdd` — scheme picker `EMBEDDER_SCHEMES` (`http`/`https`/both), host/port input, `embedderOriginsFromInput` parsing. Both-schemes note: *"uses 80 for http and 443 for https; for other ports, add each scheme separately."* Always-shown note: an https page can only embed over https (`embedHttpsNote`, varies wording for container vs. host). Added origins show "pending — saved when you click save" until the dialog's Save POSTs the batch (server-side `Config.addFrameAncestors`); removing a pending origin before Save un-stages it (re-registering the baseline…

### 4. Updates tab (`UpdatesTab.ts`)

Staged fields: `channel` (`'stable'|'beta'` radios), `autoUpdate` (checkbox), `updateCheckIntervalMinutes` (number, bounds **5–1440**, debounced 500ms + blur-commit; out-of-range leaves the typed value on screen with *"interval must be between 5 and 1440 minutes"*, nothing staged), `githubOwner` (text, blur-commit, empty → *"github owner cannot be empty"*). Dev mode (`!s.isInstalled`) shows only `current: vX — dev mode — packaging features disabled`.

**Action row**: one dual-purpose button — "check for updates now" (`POST /api/updates/check`) when nothing is ready, flips to "apply vX" (green, `.settings-btn-ready`) once `status==='ready'`; label line shows live state: `up to date: vX` / `checking for updates…` / `downloading vX — n%` / `update: vX` / `apply failed: <reason>` / `check failed: <reason>`.

**Apply flow** (`POST /api/updates/apply`): shows "installing update…", polls `/api/updates/status` every `APPLY_POLL_MS=2000`ms. A lost answer (proxy 502/503/504 or dropped connection) is followed via `LostApplyWatch` rather than treated as failure. 200 response → `startRestart(mode)`: `mode==='reconnect'` (Linux) mounts `UpgradingOverlay` and calls `runUpgradingHandoff`; otherwise shows "server restarting to apply update — page will reload…" and reloads after `APPLY_RELOAD_DELAY_MS=5000`ms. A declined elevation prompt (Windows machine-wide) is reported as a decline, not an error, via `reasonToUserMessage('uac-declined', '')`. A failed apply re-runs `runRefresh()` and then polls every 2s (`settleAfterFailure`) while status is still `checking`/`downloading`.

### 5. Service tab (`ServiceTab.ts`)

Platform-gated (`resp.supported`; on Windows always supported, Linux gated by systemd detection). Linux shows a **scope** radio (`user`/`system (req. sudo)`) derived by `scopeRadioState()`: once a service is installed the radios lock (rendered enabled with `tabindex=-1` + CSS `pointer-events:none`, **not** `disabled`, because Chromium desaturates `accent-color` on `:disabled` — item 42). System-scope **install** is gated by `systemServiceInstallGate`: disabled with note *"system service install requires installing system-wide for all users first."* unless `/opt` already holds a machine-wide install.

**Install** (`POST /api/service/install {scope}`): user-scope on Linux needs no confirm; everything else goes through `AdminConfirmModal`. Success triggers `startInstallHandoffPoll` (shared with `WelcomeModal`): navigates to the new port, or shows "reconnecting…" + reload after `INSTALL_HANDOFF_RECONNECT_DELAY_MS`, or on timeout shows `INSTALL_HANDOFF_TIMEOUT_MESSAGE` without re-enabling the button (the install *did* happen).

**Uninstall** (`POST /api/service/uninstall`): system-scope Linux polls `/api/service/uninstall` completion async (`pollServiceUninstalled`) because the teardown helper runs outside this process's cgroup; `'uninstalled'` or `'stopped'` (this page's own server going quiet) both count as success and show `uninstallFollowupMessage()`: *"service removed. the system service has been stopped. relaunch the app manually to use local mode."* Otherwise it is a local relaunch: mtime-based polling of `/api/discover` (`baselineMtime`, max 30 × 2s iterations) navigates to the new `webPort` once `configMtime` changes.

### 6. Server tab (`ServerTab.ts`)

Ports card: **HTTP port** (`webPort`, staged) and **HTTPS port** (`httpsPort`, staged, disabled until mkcert is installed and a cert exists — `HTTPS_PORT_GATE_NOTE`). `PORT_COLLISION_ERROR = 'the http and https ports must differ.'` fires inline on whichever row was just edited onto the other's value; editing the other row later auto-re-stages the collided one (`rejudgeHttpPort`/`httpCollision`/`httpsCollision`). `subPrivilegedPortNotice`: on linux/darwin only, a port `<1024` shows *"ports below 1024 need elevated privileges on this platform; the server may fail to start."* Saving either port restarts the server (`PORT_RESTART_NOTE`).

App card: **reset all my settings** → `ResetConfirmModal.confirm()` → `settingsService.reset()` (POST `/api/settings/reset`, wipes user_settings/device_labels/device_settings) + (host only) PATCH `/api/config {firstRunComplete:false}` + PATCH `/api/settings` resetting `serviceFirstRunSeen:false, bookmarkDismissedForPort:null, bookmarkDismissedGlobally:false, adminScopeBannerDismissed:false`, then reload. **Change password**, **log out** actions (not detailed further here). **Stop server & exit**: `ConfirmModal`, `POST /api/server/shutdown`, `window.close()` then an "app stopped" overlay fallback; disabled in service mode (`stopServerButtonState`) with note *"managed by the system service — stop it via your service manager, or uninstall the service."* **Resta…

`appSectionButtonsState()` pure logic: `showInstallAllUsers = linux && !container`; `installAllUsersDisabled = linux && machineWide`; `showUninstall = (linux || win32) && !container`.

### 7. Dependencies tab (`DependenciesTab.ts` wraps `DependencyPanel.ts`)

Table columns: Dependency (+ paired badge, e.g. Node.js shows "+ node-pty"), Installed, Latest, Status, Action. **check for updates** button → `POST /api/dependencies/check`. Per-row **install/update** button (`POST /api/dependencies/:name/update`) — same endpoint for both; `offersInstall(dep)` = status `NotInstalled`, or `Error` with `deferInstall && installedVersion===null` (so a failed on-demand install gets a retry button rather than a dead badge). A dependency flagged `requiresRestart` (only `nodejs`) shows a restart prompt after a successful update; **Restart Now** → `POST /api/dependencies/restart`, blanks to "Restarting…", polls `/api/dependencies` until it answers OK or a stale-token 403 (proof the new process is up), then reloads. A refused `/api/d…

#### Per-dependency definitions (`DependencyDefinitions.ts`)

| Dependency | Scope | Source | Latest lookup | Verification | Restart | Defer install |
|---|---|---|---|---|---|---|
| **nodejs** | host-only (image supplies its own on container) | `nodeDistBase()` (`WS_SCRCPY_NODE_DIST_BASE` override, default `https://nodejs.org/dist`); archive at `v<ver>/node-v<ver>-<plat>-<arch>.<ext>` | `<base>/index.json`, filtered to LTS releases whose ABI is covered by the bundled node-pty prebuilt manifest | `SHASUMS256.txt` + detached `.sig` verified against pinned Node release OpenPGP keys (`verifyOpenPgp.ts`, `NODE_RELEASE_KEYS`) | **true** | no |
| **adb** (platform-tools) | host | Google's `repository2-3.xml` (`ADB_REPOSITORY_XML_URL`); versioned archive `platform-tools_r<ver>-<win|linux>.zip` | parsed from the same XML (`parseAdbArchive`) | size + SHA-1 from the XML (`verifySha1`) + Windows Authenticode check on the binary | false | no |
| **scrcpy-server** | host + container (image seeds it) | `https://github.com/Genymobile/scrcpy/releases/download/v<ver>/scrcpy-server-v<ver>` | GitHub releases API; falls back to bundled `SERVER_VERSION`/`SERVER_JAR_SHA256` (`fallbackVersion`) when the lookup is *refused* (not merely unreachable) | release `SHA256SUMS.txt` + detached `.asc` signed by pinned scrcpy release keys (`SCRCPY_RELEASE_KEYS`) | false | no |
| **mkcert** | host-only, fetched on first use | fork `bilbospocketses/mkcert` releases (tracks **latest**, no pinned version); `mkcertUrlBases()` override via `WS_SCRCPY_MKCERT_URL_BASE` | GitHub `releases/latest` | per-release `mkcert-<ver>-SHA256SUMS.txt` manifest must carry a **Sigstore build-provenance attestation** signed by the fork's own GitHub Actions release workflow at that exact tag (`mkcertProvenance.ts`); SHA-256 of the binary then checked against the manifest | false | **yes** (never auto-installed at boot; installed on first "generate" click or via its own Dependencies-tab install button) |

Verification primitives: `verifySha256.ts` (streamed SHA-256/SHA-1 file hashing), `verifyOpenPgp.ts` (OpenPGP detached-signature verification against pinned `ReleaseKeySet`s, with a GnuPG-style key-renewal acceptance policy for keys resigned after the signature date), `mkcertProvenance.ts` (Sigstore bundle verification against the public-good trust root + an exact `issuer`/`identityPattern` policy, plus an in-toto/SLSA statement check that the attestation's subject digest matches the manifest).

**Boot-time check**: `DependencyManager.checkAll({boot:true})` (checks installed + latest for every non-deferred definition); `WS_SCRCPY_SKIP_BOOT_LATEST=1` skips the latest-lookup for already-installed deps to spare GitHub rate limits in fast test tiers. `autoInstallMissing()` downloads anything missing except `deferInstall` ones. In container mode, `getDependencyDefinitions(path,{inContainer:true})` drops `hostOnly` definitions entirely (nodejs, mkcert), and the boot repair instead re-seeds `scrcpy-server` from the image if the volume's copy differs.

**Error/status states** (`DependencyStatus`): `Unknown`, `Checking`, `NotInstalled`, `UpToDate`, `UpdateAvailable`, `Error`. `latestLookup.outcome` distinguishes `refused` (HTTP status from upstream, e.g. rate limit) from an unreachable network — only a *refused* lookup is allowed to fall back to a bundled `fallbackVersion`. Concurrent `update()` calls for the same name are coalesced (`inFlightUpdates`); per-call scratch dirs are `os.tmpdir()/ws-scrcpy-web-update-<name>-<uuid>` created `0700`, non-recursive (collision = error, not silent reuse).

### 8. Update service (server) — `UpdateService.ts`

Built on Velopack (`UpdateManager`); dev-mode detection = presence of `sq.version` + successful `UpdateManager` construction. `autoUpdate=true` gates **auto-download only**; apply is always user-initiated. Channels: `stable` / `beta`; the **beta channel also offers stable releases** (`feedChannels('beta') = ['beta','stable']`) so a beta installer never loses the ability to track stable once stable catches up; the explicit Velopack channel name is platform-qualified (`linux-<channel>` on Linux). Check uses one GitHub-releases-API resolution per tick (`GithubReleaseFeedResolver`, ETag-cached) rather than Velopack's own `GithubSource` (which only reads the 10 newest releases). `VELOPACK_CHECK_TIMEOUT_MS=60000`, `DOWNLOAD_STALL_TIMEOUT_MS=120000` (a download rep…

**Apply (`applyUpdate()`)**: refuses a second concurrent apply. Windows downloads the Velopack package first (`downloadBeforeApply`) then calls `waitExitThenApplyUpdate`. **Linux**: Velopack's own apply path is bypassed entirely (it mis-derives its locator from an AppImage root). Instead: download `WsScrcpyWeb-linux-<channel>.AppImage` + `SHA256SUMS` from `releaseAssetUrl` (overridable via `WS_SCRCPY_RELEASE_URL_BASE`), verify SHA-256 against the entry matched by **basename** in `SHA256SUMS` (`parseSha256Sums`) — a missing entry or mismatch deletes the staged file and throws, aborting the apply before anything irreversible happens. Then hand off to an out-of-mount helper binary (staged at `<dataRoot>/control/operation-server/ws-scrcpy-web-launcher.exe`, spaw…

**Client-side apply outcomes**: 200 → "restarting…" + 5s-delayed reload (Windows) or `runUpgradingHandoff` (Linux `mode:'reconnect'`) which mounts `UpgradingOverlay` (a non-dismissible full-viewport `<dialog>` with states `applying`/`reconnecting`/`timeout`) and calls `reconnectAfterApply`; on timeout shows *"update applied. if this page doesn't return on its own, reopen <url>."* A lost/declined/failed apply is classified by `classifyFailedApply`/`LostApplyWatch` (home-page `UpdateButton.ts` mirrors this exact state machine: idle/checking/downloading/ready/error, 30s slow poll / 2s fast poll while downloading or installing, 403 → hide and stop polling for good).

### 9. Local HTTPS tab (`LocalHttpsTab.ts` + server `CertService.ts`/`createCertService.ts`/`tls/*`)

Three cards: **Certificate**, **Trust**, **Exposure**. A banner above all cards when mkcert is not installed (`MKCERT_MISSING_NOTICE`, linking to the Dependencies tab); generate and the subject controls are disabled while it is missing, revoke/CA-download/exposure remain usable.

**Subject**: radio `ip address` / `hostname`, plus a combobox (`buildCombobox`) that, in IP mode, lists every RFC1918 candidate address this machine has (`candidateIps`); the box itself is the single source of truth fed to generate. Switching kind preserves each kind's last-typed value. Hostname mode refuses any real internet TLD or listed public suffix (`isPublicSuffix`, `publicSuffixWarning`): *`"<name>" is an internet domain ending, not a computer's name, so it can't be used. use something like <name>.lan, or the name your devices use to reach this computer.`* Guide line follows the chosen kind: *"must match the address/name you type on the other device to reach this server."*

**Generate** (`POST /api/tls/generate`) is gated by three conditions combined (`applyGenerateGate`): mkcert missing, a generate already in flight, or the current hostname being a refused public suffix. Server-side `CertService.generate(kind,value)`: deletes any existing `rootCA.pem`/`rootCA-key.pem` **before every spawn** (so a failed regenerate never leaves a stale CA on disk alongside a working leaf), `chmod 0700` on `CAROOT` (POSIX), spawns the vendored mkcert (never PATH) with `-cert-file`/`-key-file` absolute, `TRUST_STORES=none`, and `-name-constraints` covering **both** IP and DNS name spaces (`nameConstraintsFor`) so a hostname-subject CA is never left half-constrained. A subject carrying a port suffix is rejected before the spawn. `MKCERT_TIMEOUT_MS…

**Revoke** (`POST /api/tls/revoke`, admin-confirmed via `ConfirmModal`) deletes the CA and the leaf; disabled until a certificate exists.

**CA download** (`GET /api/tls/ca-root`, file name `CA_ROOT_DOWNLOAD_FILE_NAME`): disabled when `caPresent===false` (e.g. a failed regenerate that already deleted the old CA), with note *"regenerate to restore the ca download."* Trust line points to `help/certificate-subject.html#4-installing-a-certificate-establishing-trust` with per-OS instructions including a Firefox-specific note (Firefox has its own cert store).

**Notices** (all `[unverified]` exact wording pulled from source, persistent, not transient): certificate-subject/local-address mismatch (`certSubjectMismatchNotice`, only for RFC1918 IPv4 subjects, since the candidate oracle can't speak to other address classes) → *"this certificate names X, which is no longer an address of this machine. regenerate, or switch to a hostname."*; expiry inside 30 days (`EXPIRY_WARNING_DAYS`) or already expired (`certExpiryNotice`); listener-truth notices (`listenerStatusNotice`) distinguishing `restart-required`, `config-override`, `port-collision`, `bind-failed`, and a bound-but-stale-leaf case — each with its own actionable text, deliberately never silently regenerating.

**Exposure** (plain-HTTP behavior once a cert exists): `POST /api/tls/exposure {mode}` where `mode ∈ {open, httpsOnly, redirect}` — its **own dedicated route**, not staged through the batch Save, because it takes effect immediately with no restart. `HttpServer.readHttpExposure()` re-reads the DB key (`HTTP_EXPOSURE_KEY = 'httpExposure'`) on every plain-HTTP request. **Loopback is exempt from both narrowed modes** (`decideHttpRequest`): a caller on `127.0.0.1`/`::1` always gets `'serve'`, which is the deliberate fail-safe that keeps a recovery path to Settings even if the cert goes bad. An unrecognised/corrupt mode value also defaults to `'serve'` (never bricks access). `httpsOnly`/`redirect` are gated by `EXPOSURE_NEEDS_CERTIFICATE`/`EXPOSURE_NEEDS_RESTART` …

**Cert/key storage** (`certPaths.ts`): POSIX — `<dataRoot>/tls/{ca,cert.pem,key.pem}` (survives app updates and `docker rm`, since it's on the mounted data volume). Windows — **per-user**, `%LOCALAPPDATA%\WsScrcpyWeb-tls\{ca,cert.pem,key.pem}`, deliberately *outside* the per-user app folder so an uninstall/reinstall doesn't strand the CA every device already trusts; `migrateLegacyTlsHome` does a one-time atomic folder rename from the pre-2026-09-27 location, never overwriting an existing non-empty new home.

### 10. Welcome / first-run / container gating (`containerGate.ts`)

`showsWelcomeWizard({docker, firstRunComplete})`: shown only on a non-container host with `firstRunComplete===false`. **WelcomeModal** (`WelcomeModal.ts`): non-dismissible, shows the bound URL (`sameOriginBase(webPort)`), a "run as a service?" question with Yes/No, and on Linux a scope fieldset (`just for me (no sudo)` / `all users (requires sudo)`, probed via `/api/service/status`) morphing the copy to "run as a systemd service?"/"run as a windows service?" per platform. A "don't show this again on this browser" checkbox only persists on the "no, run on demand" path. Fixed hint texts cover bookmarking-after-redirect and the ~3-minute first-launch dependency download window. **SystemWideInstallModal** offers install-to-`/opt` for all users (non-dismissible, …

**FirstRunBanner** polls `/api/dependencies` every 15s and shows only for **non-deferred** dependencies stuck at `installedVersion===null` with status `Error`/`Unknown` (mkcert, being `deferInstall`, never counts, so enabling HTTPS is never mistaken for an incomplete install): *"Setup incomplete — <names> failed to download. Check your network connection."* with a **Retry** button (`POST /api/dependencies/retry-install`).

**BookmarkReminder** (`bookmarkGate.shouldShowBookmark`): shown unless globally dismissed, or the current port equals the port it was dismissed for (a port change re-shows it). Two kinds — `bookmark` and `service` (first load of a service instance, gated on per-user `serviceFirstRunSeen===false`) — three exits: **got it** (`bookmarkDismissedForPort=<port>`), **never again** (confirmed via `ConfirmModal`, sets `bookmarkDismissedGlobally=true`), **×** (dismissed for this page view only, returns on reload).

### 11. Theme (`ThemeToggle.ts`)

Synchronous first paint from `prefers-color-scheme` (`initTheme`, no flash); `applyStoredTheme()` then loads the DB-stored `theme` (`'dark'|'light'`) and overrides it, or on a fresh install seeds the DB with the OS reading. Toggle button flips and persists via `settingsService.patchGlobal({theme})` (fire-and-forget); re-renders via a `MutationObserver` on `document.documentElement`'s `data-theme` attribute (self-disconnects if its button leaves the DOM).

### 12. Admin-scope / embedding prompts

**AdminScopeBanner** (`bannerStateFor`): `hidden` for `adminScope ∈ {authenticated, remote}`; for `adminScope==='local'`, `local-actionable` (loopback caller, offers **Set up sign-in** → opens Settings, and **Allow remote admin without sign-in** → `RemoteAdminWarningModal.confirm()` then `PATCH /api/config {allowRemoteAdmin:true}`) or `local-readonly` (remote caller, instructions only, no buttons — a working toggle here would be exploitable). Per-user **Dismiss** persists `adminScopeBannerDismissed` via `PATCH /api/settings`; "reset welcome and bookmark prompts" clears it.

**EmbedRequestModal/Prompt**: `startEmbedRequestWatch(callerIsLocal)` polls `GET /api/embed-request` every 5s (stops permanently on 403) for a pending cross-app embed request; when found, raises a **non-dismissible** `EmbedRequestModal` showing the asking app's name and **origin verbatim**, a live countdown (mirrors server `REQUEST_TTL_MS=5min`), and a 3s poll for server-side withdrawal (`cancelled`) while the dialog is open. Only `deny`/`approve` send a decision (`POST /api/embed-request/decision`); `expired` and `cancelled` resolve the dialog into a read-and-acknowledge state with no network call.

[Some lines truncated to 768 chars. Use agent://SettingsScout:raw:7-7 to read line 7 whole; cut lines run to line 98, each read the same way]


## B.7 Launcher, Linux service/tray, Docker, release

## ws-scrcpy-web — Launcher / Linux Integration / Docker / Dev-Scripts Behavior Spec

### 1. Launcher binary overview

`launcher/src/main.rs` — single binary `ws-scrcpy-web-launcher` (`launcher/Cargo.toml:1-10`). Dispatch chain in `main()`, each branch calling `std::process::exit` on match (all flags checked positionally, earliest match wins):

| Order | Flag / trigger | Handler | Platform |
|---|---|---|---|
| 1 | `--print-active-session` | prints active WTS session id | Windows only |
| 2 | `--no-log` | `log::disable()` | all |
| 3 | pkexec child detection (`PKEXEC_UID` env) | `log::route_to_stderr(...)` | Linux |
| 4 | (always) | rotate `service.log` via copy-truncate at 10MB | Linux |
| 5 | `--unzip*` | `unzip_handler::handle` | all |
| 6 | `--linux-apply` | `linux_apply::handle` | Linux |
| 7 | `--linux-service-teardown` | `linux_service::handle` | Linux |
| 8 | `--linux-service-install-handoff` | `linux_service::handle_install_handoff` | Linux |
| 9 | `--linux-app-uninstall` | `linux_app_uninstall::handle` | Linux |
| 10 | `--linux-app-uninstall-elevated` | `linux_app_uninstall::handle_elevated` | Linux |
| 11 | `--install-system-service`/`--uninstall-system-service`/`--system-service-status` | `system_service_cli::handle` | Linux |
| 12 | service-defer check (active system service) | opens browser, exits 0 | Linux |
| 13 | `/opt` bootstrap re-exec check | may `exec` `/opt` binary | Linux |
| 14 | `--operation-server`/`--upgrade-server` | `operation_server::handle` | all |
| 15 | Velopack hook flags | `hooks::handle_velopack_hook` | all |
| 16 | single-instance guard acquire | may exit 0 if already running | all |
| 17 | normal launch: `supervisor::run()` | — | all |

`main.rs:1-40` module list: Windows-only modules (`uac_requester`, `install_acl`, `job_object`, `user_session_spawn`, `win_util`, `windows_app_uninstall`) are gated `#[cfg(windows)]`; Linux-only modules (`linux_app_uninstall`, `linux_apply`, `linux_service`, `linux_tray`, `root_trust_guard`, `system_service_cli`) gated `#[cfg(target_os = "linux")]`. `operation_server`, `tray_supervisor`, `spawn`, `paths`, `log`, `supervisor`, `single_instance`, `hooks`, `elevated_runner`, `unzip_handler`, `uac_requester` are cross-platform entry files (bodies conditionally compiled inside).

### 2. Path/data-root resolution (Linux)

`common/src/config.rs`:
- `data_root_for_linux(data_root, xdg_data_home, home)` precedence: `DATA_ROOT` (used verbatim, NOT joined with `WsScrcpyWeb`) → `$XDG_DATA_HOME/WsScrcpyWeb` → `$HOME/.local/share/WsScrcpyWeb`. If none of the three is set: **panics** ("never silently fall back to ephemeral, world-writable /tmp"; a systemd service must set `Environment=DATA_ROOT`).
- `try_data_root_for_linux` / `try_data_root_from_env`: non-panicking variant returning `None`, used by best-effort callers (e.g. startup `service.log` rotation under a teardown transient unit with no env).
- `AppConfig` (`config.rs:110-125`): fields `installMode: Option<String>`, `firstRunComplete: bool`, `webPort: Option<u16>`. `is_service_mode()` = `install_mode` ends with `-service`. `load`/`load_from`: lenient, malformed/missing → `Default`. `load_strict`/`load_strict_from`: `Err` on missing or malformed.

`launcher/src/paths.rs` (`Paths::compute`/`from_env`):
- `install_root` = `exe_dir.parent()`.
- `data_root`: Windows → `data_root_for_windows`; Linux → `DATA_ROOT`/`XDG_DATA_HOME`/`HOME` resolution above, read from env inside `from_env`.
- `deps_path` = `DEPS_PATH` env override, else `<data_root>/dependencies`.
- `restart_marker` = `<data_root>/.restart`.
- `old_node` = `<deps_path>/node/node.old` (Linux) / `node.exe.old` (Windows) — a stale Node binary left by a Node self-update, cleaned at loop top.

Dev layout (no install): launcher binary at `target/debug|release/`, `install_root` = repo root (no `config.json` present, `load` defaults).

### 3. Supervisor loop (`launcher/src/supervisor.rs`)

`run()` sequence:
1. `Paths::from_env()`.
2. Linux: `root_trust_guard::guard(&deps_path)` + `guard_opt_install()` (§7).
3. Delete stale `.restart` marker and stale `apply-update-pending` marker.
4. Load `config.json`; honor `--local-takeover` override (forces local tray mode even if `installMode` is a service, used during uninstall handoff).
5. Windows: start tray-supervisor background poller. Linux: tray runs as a thread later (§8), not here.
6. Refresh the `operation-server` helper binary copy in dataRoot (best-effort; retried on Windows if busy, not on Linux `ETXTBSY`).
7. If service mode: write operation-server stop marker, `wait_for_port_free(port, 5s)` before spawning Node.
8. Install Ctrl+C handler → sets `stop: Arc<AtomicBool>`.
9. Linux: `linux_tray::spawn_if_eligible(&data_root, stop.clone())`.
10. Main loop:
   a. `cleanup_old_node`.
   b. `spawn::spawn_server(deps_path, data_root, first_spawn)` — `first_spawn` (only true once per launcher process) sets `WS_SCRCPY_OPEN_BROWSER=1` on the child env so Node opens a browser tab only on the very first spawn, never on restarts.
   c. `wait_with_signal` — polls child exit every 100ms or Ctrl+C.
   d. On stop-signal: return `(exit_code, tray_stop_flag)` — no restart.
   e. Windows: special-case `uninstall-pending` marker (schtasks dance) — N/A Linux.
   f. Else: compute `marker_exists = restart_marker.exists()`.
      - `decide_restart(exit_code, marker_exists)`: marker **always wins** over exit code. Returns `RestartMarker` if marker present (consumed/deleted), else `ExitCode75` if `exit_code == 75`, else `None`.
      - If `None`: `decide_crash_restart(exit_code, running_as_service, restarts_so_far, uptime)`:
        - `exit_code == 0` → `CleanExit` (stop, no restart).
        - `running_as_service` (env `WS_SCRCPY_SERVICE=1`) → `LeaveToServiceManager` (stop; systemd/servy own crash recovery).
        - Else: `prior = restarts_so_far` reset to 0 if `uptime >= CRASH_COUNT_RESET_UPTIME` (**60s**); if `prior >= MAX_CRASH_RESTARTS` (**3**) → `GiveUp` (logs `"3 restart attempts, won't retry, review error logging"`, stop); else → `Restart{attempt: prior+1}` (log `"server crashed after {uptime}s up; restarting (attempt {attempt} of 3)"`).
      - Either restart path → sleep `RESTART_DELAY` (**2s**), loop.
   g. Graceful-stop timeout: `GRACEFUL_STOP_TIMEOUT = 10s` — on a stop request, supervisor waits this long for Node's own SIGTERM handler (`gracefulShutdown`: adb kill-server, service release, SQLite backup) before a hard kill.

Constants: `EXIT_RESTART=75`, `RESTART_DELAY=2s`, `POLL_INTERVAL=100ms`, `MAX_CRASH_RESTARTS=3`, `CRASH_COUNT_RESET_UPTIME=60s`, `HELPER_REFRESH_RETRY_INTERVAL=2s`, `HELPER_REFRESH_RETRY_BUDGET=120s`.

### 4. Single-instance lock (Linux) — `launcher/src/single_instance.rs`

Non-Windows impl: `flock(FlockOperation::NonBlockingLockExclusive)` on a lock file, held for the process lifetime (dropped automatically on exit/crash — kernel releases flock when the fd closes).

**Lock path precedence** (`lock_path`): `$XDG_RUNTIME_DIR/ws-scrcpy-web.lock` if set and non-empty, else `<data_root>/control/instance.lock` (falls back to `/tmp/control/instance.lock` if no data root resolvable — caller passes `data_root_from_env()`).

`acquire()`: `Ok(Some(guard))` = acquired (sole instance); `Ok(None)` = another instance holds it (caller logs and exits 0, after attempting to reopen the running instance's URL via `xdg-open http://localhost:<webPort>` read from `config.json`); `Err` = unexpected I/O error (proceeds without the guard, logged).

No elevation-level distinction on Linux (`is_elevated()` always `false`) — unlike Windows' separate `-User`/`-Admin` mutex names.

### 5. Browser auto-open rule

`spawn.rs` (non-Windows `spawn_server`): sets child env `WS_SCRCPY_OPEN_BROWSER=1` only when `open_browser` param (= supervisor's `first_spawn`) is true. Node side owns the actual `xdg-open`/browser launch once bound. A supervisor-driven restart (webPort change, crash, exit-75) passes `false` — never re-pops a tab. A `linux_apply` relaunch after an in-app update sets `WS_SCRCPY_NO_BROWSER=1` (Node-side override) to suppress the open-tab on relaunch. Child env also always carries `WS_SCRCPY_LAUNCHER=1` (signature the Node `openBrowser.ts` checks: a supervisor exists and owns tab policy — distinct from `DEPS_PATH`, which Docker/e2e/dev scripts also set).

### 6. Node resolution (`spawn.rs`)

`resolve_node_with(deps_path, exe_dir)`: tries, in order, `<deps_path>/node/bin/node`, `<deps_path>/node/node`, `<exe_dir>/seed/node/bin/node`, `<exe_dir>/seed/node/node`. Errors if none exist — never falls back to system `PATH`. `resolve_server_entry_with(exe_dir)` = `<exe_dir>/dist/index.js`, errors if absent.

`spawn_server` (non-Windows): raises soft `RLIMIT_NOFILE` to `NOFILE_LIMIT=4096` (or process hard limit if lower) before spawn, best-effort, never lowers an already-higher limit, never touches hard limit (no privilege). Child env: `DEPS_PATH`, `DATA_ROOT`, `WS_SCRCPY_LAUNCHER=1`, conditionally `WS_SCRCPY_OPEN_BROWSER=1`. stdout+stderr both redirected to `<data_root>/logs/server.log` (opened append, rotated by rename at 10MB — safe because prior Node child released the fd between spawns). `server.log` is a thin crash-catcher; normal app output goes to `ws-scrcpy-web.log` (Node-side logger), not server.log.

### 7. Root-trust guard (`launcher/src/root_trust_guard.rs`) — Linux, D14/D14b

Runs only when `euid == 0` (checked via `rustix::process::geteuid().is_root()`).

- `guard(deps_path)`: if `deps_path` exists, walks it (`find_unsafe`) without following symlinks; "unsafe" = any entry not owned by uid 0, or group/other-writable (`mode & 0o022 != 0`), or a symlink whose resolved target leaves the tree (lexical normalization, no disk follow), or the root itself being a symlink. On any unsafe entry (or I/O error during the walk, treated as unsafe) → deletes the whole tree (`remove_file` if root is itself a symlink/non-dir, else `remove_dir_all`) so the service re-provisions Node/adb/scrcpy-server as root. Fixes a beta.145 regression where a system install staged the desktop user's own `dependencies/` with `cp -a`, letting that user replace `node` for root to exec.
- `guard_opt_install()`: only acts when the running `$APPIMAGE` lexically resolves to exactly `/opt/ws-scrcpy-web/<name>.AppImage`. If that binary is a symlink → logs error, does nothing (refuses to follow). If owner/mode unsafe → replaces it with a **fresh root-owned 0755 copy** (`replace_with_fresh_copy`: read bytes, write to `<path>.root-repair` tmp with the right uid/mode, fsync, atomic rename over the original — a `chown` is deliberately avoided because it would leave any fd the user already holds writable). Also checks `/opt/ws-scrcpy-web/VERSION`: if unsafe, chown+chmod 0644 to root:root in place; separately, if `VERSION`'s recorded string ≠ the running binary's own `CARGO_PKG_VERSION`, rewrites it (fresh file) — keeps the bootstrapper's version-compa…

### 8. Linux tray (`launcher/src/linux_tray.rs`, `common/src/tray.rs`, `common/src/tray_policy.rs`)

Implemented via `ksni` (StatusNotifierItem over D-Bus), not a GTK/libappindicator dep. Runs as a **thread inside the launcher process** (no separate tray helper process as on Windows — the launcher already runs in-session for local and user-scope service runs).

**Eligibility** (`tray_policy::should_spawn_tray(install_mode, session_bus_present)`): spawns iff `install_mode != Some("system-service")` AND a session D-Bus is reachable. Session bus detection (`session_bus_present`): `DBUS_SESSION_BUS_ADDRESS` non-blank set, OR `$XDG_RUNTIME_DIR/bus` socket exists (the latter auto-exports the env var if missing, via `ensure_session_bus_env`). Stand-down (silent, one INFO log line via `tray_stand_down_line`) for: system-scope service, no session bus, no StatusNotifier host on the bus (stock GNOME/Fedora Workstation — detected at `common::tray::run` returning `Cancelled`).

**Icon**: 22×22 ARGB32 pixmap embedded from `assets/tray-icon-22.argb` (`common/src/tray_policy.rs`, `icon_argb_22()` — validates exact byte length `22*22*4=1936`, errors (no spawn) if the asset is malformed). 22px chosen because KDE/AppIndicator panels render natively at that size.

**Menu/tooltip labels** (`TrayLabels::for_mode(is_service_mode)`):
| | local mode | service mode |
|---|---|---|
| tooltip | `ws-scrcpy-web` | `ws-scrcpy-web (service)` |
| exit action label | `stop the server and quit` | `stop the service and quit` |

Menu: **Open** (left-click or menu item → `xdg-open http://localhost:<webPort>`, re-reads `config.json` on every click so a port/mode change mid-session is reflected) and **Exit… → stop the server/service and quit** (there is no confirmation dialog on Linux — the submenu action text itself is the confirmation; selecting it returns `TrayAction::ConfirmedExit`, which flips the shared `stop` `AtomicBool` and the supervisor's `wait_with_signal` sends SIGTERM to Node). No StatusNotifier host / no bus → `TrayAction::Cancelled`, settings page remains the only stop affordance.

### 9. Systemd unit content

Two scopes, written by Node (`SystemdClient.ts`, `renderUnitFile`); Rust never writes unit files but reads/removes them.

| | Unit path | `ExecStart` | `Environment=` | `Restart=`/`RestartSec` | `WantedBy` | Elevation |
|---|---|---|---|---|---|---|
| **user** | `~/.config/systemd/user/<name>.service` | `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` if it exists, else `<dataRoot>/bin/WsScrcpyWeb.AppImage` (a stable, `chmod 0755` copy of the source AppImage — never the volatile throwaway download path) | none pinned (reads config.json) | `on-failure` / `5s` | `default.target` | none |
| **system** | `/etc/systemd/system/<name>.service` | `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` | `DATA_ROOT=/var/lib/ws-scrcpy-web`, `WS_SCRCPY_SERVICE=1`, (pre-2026-10-04 also `WS_SCRCPY_WEB_PORT=<port>`, now removed/stripped on apply — port lives in config.json only) | `on-failure` / `2s` | `multi-user.target` | `pkexec` (desktop, one prompt) or `sudo` (headless) |

Both: `Type=simple`, `StandardOutput=`/`StandardError=append:<data_root>/logs/service.log`, `StartLimitIntervalSec`/`StartLimitBurst` in `[Unit]` (not `[Service]` — systemd silently ignores it there; system unit: `StartLimitIntervalSec=60`, `StartLimitBurst=10`). Running state read with `systemctl is-active` (machine-readable), never `systemctl status`.

System unit's short `RestartSec=2s` is load-bearing for **desktop takeover**: installing the system service while a local instance holds the port enables the unit (not `--now`‑then‑immediately‑bind); the first bind fails (port held), systemd retries every 2s (up to 10 times/60s), the local copy gracefully shuts itself down freeing the port, and the next retry binds — no out-of-cgroup detached-helper hand-off for system scope (that approach was replaced after 5 consecutive runtime-smoke failures rooted in `kill(2)` EPERM on a setuid `pkexec` child — see `docs/specs/2026-06-12-system-service-install-redesign-design.md` §2,§7). User scope *does* still use the out-of-cgroup hand-off (§10 below) because it shares a per-user single-instance flock with the local ap…

### 10. Install/uninstall mechanics

#### Staging (`/opt` for system scope)
- `WsScrcpyWeb.AppImage` → labeled SELinux `bin_t` via persistent `semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'` + `restorecon -R`. Required because `init_t` (root service's SELinux domain) is forbidden from exec'ing a `user_home_t` AppImage.
- `dependencies/` beside it starts **empty, root-owned 0755**; the service provisions its own Node/adb/scrcpy-server as root (never copies a user's tree — D14). Dependency tar extraction uses `--no-same-owner --no-same-permissions` so nodejs.org's recorded uid 1001 never lands on disk (D16).
- `config.json` + `logs/` live at `/var/lib/ws-scrcpy-web` — labeled `var_lib_t` by the **policy's own default** `/var/lib(/.*)?` rule, **no custom `semanage` rule** (a `restorecon -R` only, belt-and-suspenders). `/var/opt` was tried first and is **permanently impossible** on Fedora: `/var/opt → /opt` is a stock SELinux equivalency rule, so `semanage` rejects any custom type rule beneath it (`docs/specs/2026-06-12-system-state-var-lib-design.md`).
- `/opt` AppImage is always written as a **fresh root-owned file** (`install -o root -g root -m 0755 <src> <target>.new` + rename), never a `chown` (would leave any fd the user already holds writable) and never `mv` of a user-owned temp file.
- `umask(0o022)` is forced before the one-shot root install runs (pkexec/sudo preserve the caller's umask, which is `0002` on Ubuntu user-private-groups setups — would otherwise produce 775 dirs that `assertSafeRootDir` then refuses).
- Install waits for the unit to actually be `active`/serving (`verifyServiceStarted` polls `systemctl show` + a TCP connect to the bound port, up to 120s) — `enable --now` returning only proves systemd *queued* the start, and `Type=simple` flips active the instant it forks.

#### Uninstall (service teardown) — `launcher/src/linux_service.rs`
Out-of-cgroup: Node launches the teardown via `systemd-run --<scope> --collect <binary> --linux-service-teardown --scope <user|system> --unit <name>` so the teardown runs in its own transient unit/cgroup, surviving the stop of the unit it tears down. Ordered steps (`teardown_commands`), every tool resolved to an absolute dir (`/usr/bin` else `/bin`, never bare-name/PATH):
1. `systemctl [--user] stop <unit>.service`
2. `systemctl [--user] disable <unit>.service`
3. `systemctl [--user] reset-failed <unit>.service` — non-zero exit here is **benign** (unit wasn't failed), logged WARN not ERROR; every other step's non-zero is a real error.
4. `rm -f <unit-file-path>`
5. System scope only: `rm -rf /opt/ws-scrcpy-web`, `rm -rf /var/lib/ws-scrcpy-web`, `semanage fcontext -d '/opt/ws-scrcpy-web(/.*)?'`
6. `systemctl [--user] daemon-reload`
7. Reap escaped `adb` daemon (`<deps>/adb/adb kill-server`) — it daemonizes out of the cgroup so the stop above cannot kill it.
8. **User scope only**: relaunch local app via `systemd-run --user --collect <appimage-path>` (reading the AppImage path from a marker at `<data_root>/control/local-appimage`, validated by `is_safe_relaunch_target`: must be absolute, no `..` component, lstat to a regular file (not a symlink, dir, special); optionally `require_root_owned`). System scope **never** auto-relaunches (headless-dominant; admin relaunches manually).

A system teardown logs to **stderr only** (`teardown_logs_to_stderr`), never a file — its `DATA_ROOT=/var/lib/ws-scrcpy-web` tree is always `rm -rf`'d, so any post-wipe file write would re-create `logs/launcher.log`; stderr lands in `journalctl -u 'wsscrcpy-teardown-*'`.

#### Install handoff (user scope; `handle_install_handoff`)
Separate helper (`--linux-service-install-handoff --scope <s> --unit <u>`), needed because a user-scope service shares the per-`$XDG_RUNTIME_DIR` single-instance flock with the local app:
1. Poll (1s cadence, 20s cap) for the configured `webPort` to go dead (local instance exits, releasing the lock).
2. `systemctl [--user] start <unit>.service`.
3. Verify "up" = `service_up(is_active, port_open)` — both systemd `is-active` **and** a live TCP probe (guards against the `Type=simple` instant-active flicker), polled 1s cadence up to 12s.
4. On success: done. On failure: roll back (run the full teardown sequence) + relaunch local via the same marker mechanism. System-scope rollback never auto-relaunches (same reasoning as above).

#### Complete app uninstall (`launcher/src/linux_app_uninstall.rs`, beta.49)
Dispatched `--linux-app-uninstall` (unelevated, spawned via `systemd-run --user --collect`) / `--linux-app-uninstall-elevated` (root). Pure builder `app_uninstall_commands(svc_scope, machine_wide, keep, bindir, data_root, xdg_runtime_dir)` returns `UninstallPlan{privileged, user_owned}`:

- **Elevation decision** (`privileged_mode`): already root (system-service-launched helper) → run `privileged` group directly, no pkexec. Non-root → re-exec self under **one** `pkexec` → lands on `--linux-app-uninstall-elevated`, which runs *only* the privileged group. A pkexec decline (exit 126/127) or a privileged failure aborts the uninstall and relaunches the running AppImage locally.
- `privileged` is **empty** (no elevation prompt) when there's no root footprint (no `/opt`, no system-scope service).
- **`user_owned`** (always, in order): `pkill -KILL -x adb` (by exact name — escapes the stray-process name match below); user-scope service teardown (if applicable); remove legacy `~/.config/autostart/ws-scrcpy-web-tray.desktop` (defensive, pre-beta.45 installs); remove `$XDG_RUNTIME_DIR/ws-scrcpy-web.lock` (if known); data-root keep/wipe (user-owned data roots only — system-scope `/var/lib` is handled in `privileged`).
- **`privileged`** (only when `machine_wide || svc_scope==System`): system-scope service teardown; `rm -rf /opt/ws-scrcpy-web` (**always full**, never kept); system-scope `/var/lib` keep/wipe; `rm -f /usr/share/applications/ws-scrcpy-web.desktop` + `update-desktop-database`; `rm -f` the hicolor 256×256 icon; `semanage fcontext -d` both `/opt/ws-scrcpy-web(/.*)?` and the legacy `/opt/ws-scrcpy-web/data(/.*)?` spec; `rm -rf /root/.local/share/WsScrcpyWeb` (stray root log tree left by pre-fix pkexec'd runs, skipped if that IS the data root).
- **`--keep` (`keep=true`) semantics** (`data_root_commands`): deletes only `dependencies/`, `bin/`, `control/` subdirectories under the data root — preserves `config.json` and `logs/`. `keep=false`: `rm -rf` the entire data-root directory.
- Stray-process kill happens **in-process** (`kill_strays`, walking `/proc`), *not* via `pkill -f <pattern>`: the helper's own argv (`.../control/operation-server/ws-scrcpy-web-launcher ... --data-root ...` or root's `/opt/ws-scrcpy-web/control/ws-scrcpy-web-launcher ...`) matches the same substring pattern, and `pkill` always spares itself — `pkill -f` would SIGKILL its own parent before later steps ran (regression observed on beta.140). `PROC_NAMES` matched: `WsScrcpyWeb`, `ws-scrcpy-web-tray`, `ws-scrcpy-web-launcher`, `scrcpy-server`.
- `--data-root` value is validated (`is_valid_data_root`) before crossing the pkexec boundary into a root `rm -rf`: must be non-empty, start with `/`, not start with `-`.
- pkexec'd elevated child logs to **stderr only** (never a file — pkexec scrubs env; `/root/...` log tree would be an unremoved stray); parent relays those lines into its own log prefixed `elevated: `.

### 11. Operation-server (`launcher/src/operation_server.rs`)

Subcommand: `--operation-server` (canonical) / `--upgrade-server` (legacy alias, kept read-side ~2 release cycles). Spawned by the post-stop handoff *after Node exits, before the new process starts*, to cover the port during an in-app update apply or service uninstall, so a browser hitting the URL mid-transition doesn't see "connection refused."

- Binds `127.0.0.1:<webPort>` (read from `config.json`); on `AddrInUse` retries the same port up to `BIND_RETRY_TIMEOUT_SECS=10s` at `BIND_RETRY_INTERVAL_MS=25ms` cadence (Node hasn't released it yet); other bind errors or a non-`AddrInUse` failure on the final candidate port advance immediately (no pointless retry) via `classify_bind_failure`; probes up to `PROBE_MAX_OFFSET=10` ports beyond the configured one if the final port is exhausted.
- Serves a static HTML page (`assets/operation-server-page.html`) on every path: 200 at `/`, 503 at `/api/*`. Two text variants, chosen by `detect_operation_variant` (checks which marker — `control/apply-update-pending` or `control/uninstall-pending` — exists at startup; `ApplyUpdate` wins if both present): "Updating app, please wait…" vs "Uninstalling service, please wait…". Page JS polls `/api/config` every ~1s and reloads on 200 JSON.
- Self-exits on: stop marker present (`<data_root>/control/operation-server-stop`, legacy name `upgrade-server-stop` also honored) — polled every `STOP_MARKER_POLL_MS=200ms`; or `MAX_LIFETIME_SECS=30` elapsed safety cap.
- Port-shift compensation: after the stop marker fires, a background probe sweeps `[configured_port .. +10]` at `PROBE_INTERVAL_MS=100ms` for the real Node's `/api/config`; once found, connection handlers return 200 + a redirect JSON pointing the polling page at the new port (`WIND_DOWN_TOTAL_SECS=15s` window).
- Connection handling: one thread per accepted TCP connection; capped at `MAX_INFLIGHT_CONNECTIONS=64` (compile-time-asserted `>= 16`) — connections beyond the ceiling are dropped (closed), the polling page just retries.
- Exit codes: `0` clean; `3` bind failed; `4` config.json read failed; `5` data-root unresolvable.

### 12. System-service CLI dispatch (`launcher/src/system_service_cli.rs`)

Routes `--install-system-service`/`--uninstall-system-service`/`--system-service-status` by resolving Node + the server entry (same path as production spawn — never system PATH) and running `node dist/index.js <forwarded flags>` **in the foreground**, inheriting stdio, propagating node's exit code verbatim (signal-killed node → `128 + signal`). This is what makes `sudo ./WsScrcpyWeb --install-system-service` and `pkexec ./WsScrcpyWeb --install-system-service` work. **Invariant**: once `owned_op` matches a flag, `handle` ALWAYS returns `Some(code)` — never silently falls through, since that would hang the awaiting `pkexec`/`sudo` forever instead of surfacing a resolution failure.

### 13. In-app update apply (`launcher/src/linux_apply.rs`)

`--linux-apply --target <path> [--staged <path>] [--wait-pid <pid>] [--service-restart --scope <s> --unit <u> [--relabel]]`. Three branches:
1. **Service-mode apply** (`--service-restart` present): stop unit (synchronous, reaps in-cgroup app + unmounts FUSE AppImage) → settle-retry `swap_appimage` up to 15s → system scope only: re-apply SELinux `bin_t` label (`restorecon` preferred, `chcon` fallback) and strip the legacy `WS_SCRCPY_WEB_PORT=` pin line from the unit file (rewritten as a fresh 0644 file + `daemon-reload`) → `systemctl start`. No bare relaunch — the unit start brings the app back.
2. **Relaunch-only** (no `--staged`): machine-wide-no-service mode; Node already did a privileged `pkexec` rename-swap of `/opt`, so this just waits for the exiting pid (releases the per-user flock) then relaunches the (already-swapped) target — never elevated.
3. **Local-mode apply**: waits for pid exit, `swap_appimage(staged, target)` (backs up target → `.bak`, moves staged over target, chmod 0755; self-healing — restores `.bak` on a mid-move failure), relaunches, cleans up staged `.new` and the `apply-update-pending` marker on either success or failure.

### 14. Logging (`common/src/log.rs`)

Per-binary log file: `<data_root>/logs/<name>.log` (launcher default name `"launcher"` if `init()` never called). Every line: `YYYY-MM-DD HH:MM:SS.fff [LEVEL] msg` (UTC, hand-rolled civil-date math, no `chrono` dep). `disable()`/`enable()`: process-global, used by wipe-uninstall cleaners to stop `create_dir_all` from resurrecting a deleted data root. `route_to_stderr(include_info)`: pkexec-child mode — writes to stderr only, never a file; `include_info=false` keeps only WARN/ERROR (shown to the user as the failure text); `include_info=true` keeps everything (relayed into the parent's own log).

Rotation: `rotate_by_rename_if_large(path, 10MB)` — rename to `<path>.1` (removing any prior `.1`) when ≥10MB, used for files the process opens per-write with no persistent fd (launcher.log, tray.log, server.log between spawns). `copy_truncate_if_large(path, 10MB)` — copy-then-truncate, used for `service.log` since systemd holds that fd open in append mode across the process's lifetime (a rename would orphan it); invoked at launcher startup only.

`stderr echo` of a normal (non-pkexec) log line is gated on `stderr().is_terminal()` — under a service, stderr is redirected to `service.log` by the service manager, so the echo is skipped (would just duplicate `launcher.log` there).

### 15. Docker image (`Dockerfile`)

Two-stage build, base `node:24-trixie-slim` pinned **by digest** (`sha256:50c3b2f6…`), Debian 13/trixie chosen over bookworm specifically because `velopack`'s native addon needs glibc ≥2.39 (bookworm has 2.36).

**Build stage**: `npm ci --ignore-scripts` (node-pty's compile-on-install skipped; prebuilt fetched instead) → copy source → `node scripts/fetch-prebuilts.mjs && stage-seed-node-pty.mjs && stage-seed-scrcpy-server.mjs && npm run build && fetch-tini.mjs /out/tini`.

**Runtime stage**:
- `apt-get update && apt-get upgrade -y` to clear CVEs the pinned base shipped (measured necessary — upstream hadn't rebuilt).
- Build-time assertion: `test -x /usr/bin/setpriv` (fails the build loudly if the base ever drops util-linux, rather than silently continuing as root at runtime).
- OCI labels (`org.opencontainers.image.source/url/title/description/licenses`) — required for GHCR package↔repo linkage.
- `npm ci --omit=dev --ignore-scripts` installs the production tree **from the lockfile in this stage** (not copied/pruned from build stage — a prune previously failed to strip the 372MB dev tree). Then removes `/root/.npm`, `/usr/local/lib/node_modules`, `npm`/`npx`/`corepack`/yarn binaries (the app never shells out to any of them; their bundled deps carried fixable CVEs Scout flagged) — asserted absent (`test ! -e`) for `@typescript`, `@playwright`, bundled npm.
- Copies `dist/`, `seed/`, `start.sh`, `docker/entrypoint.sh` (→ `/usr/local/bin/entrypoint.sh`).
- `seed/node/node` is a **symlink to the image's own node interpreter** (`/usr/local/bin/node`), not a downloaded binary — avoids a ~50MB per-leg download and guarantees arch/ABI correctness. `/app/dependencies` is a symlink to `/data/dependencies` — belt-and-braces so hydrate writes land on the volume even if something still reaches for the old path; `start.sh` honors an inherited `DEPS_PATH` rather than overriding it, so the `ENV` below is authoritative.

**Env vars set**: `DATA_ROOT=/data`, `DEPS_PATH=/data/dependencies`, `WS_SCRCPY_DOCKER=1`, `WS_SCRCPY_WEB_PORT=8000`, `NODE_ENV=production`.

**Volume**: `/data` (declared `VOLUME`). **Port**: `EXPOSE 8000` (internal always; host maps externally).

**Healthcheck**: `--interval=15s --timeout=5s --start-period=180s --retries=5`, `CMD node -e "fetch('http://127.0.0.1:8000/api/config')..."` — targets `/api/config` specifically because it's exempt from the per-instance auth token (would otherwise report unhealthy once module-18 auth is on). `start-period=180s` because first boot downloads adb (~9MB) before the server listens.

**Entrypoint**: `["/usr/local/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]`, `CMD ["/app/start.sh"]`. `tini -g` (not plain `tini`) forwards SIGTERM to the whole process **group** so it reaches `node` through `start.sh`'s bash restart loop (without `-g`, bash defers the trap until the foreground child exits, skipping Node's graceful shutdown — `docker stop` would SIGKILL after the grace period, orphaning adb state).

#### `docker/entrypoint.sh`
Root shim, runs only long enough to fix ownership then steps down:
- As root: `mkdir -p /data/dependencies /data/home /data/logs`; `chown -R 1000:1000 /data` **only if** `stat -c '%u' /data` ≠ 1000 (skips the recursive chown cost on an already-correct volume); unconditionally `chown 1000:1000 /data/home` (covers a volume that predates the home dir, which the conditional recursive chown above would otherwise skip); `export HOME=/data/home` (so adb's `.android` key pair persists across `docker rm`); `exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all -- "$@"` (drops ambient capabilities — not decorative).
- Already non-root (`docker run --user`/compose `user:`): verifies `/data`, `/data/dependencies`, `/data/home`, `/data/logs` are writable by the running uid; refuses with an explicit remediation message (`docker run --rm -u 0 -v <volume>:/data --entrypoint chown <image> -R <uid>:<gid> /data`) if not; otherwise `mkdir -p` the same four dirs, `export HOME=/data/home`, `exec "$@"`.

#### `start.sh` (dev/container supervisor; mirrors the Rust supervisor's exit-75/marker rule, used only in-container and for dev — never shipped by the installed-app path)
- Resolves `DATA_ROOT` for the restart marker the same way Node does: `DATA_ROOT` env, else `$XDG_DATA_HOME/WsScrcpyWeb`, else `$HOME/.local/share/WsScrcpyWeb`, else `dirname "$DEPS_PATH"`.
- Honors inherited `DEPS_PATH` (doesn't clobber container `ENV`).
- Node resolution: `$DEPS_PATH/node/node` then `$SCRIPT_DIR/seed/node/node`; exits 1 with a reinstall instruction if neither executable exists.
- Deletes stale `.restart` marker at start.
- Traps `TERM`/`INT`, forwards the signal to the backgrounded Node child's pid (tracked in `NODE_PID`) and double-`wait`s (first `wait` return `>128` means it was interrupted by the trap, not the child; wait again for the real exit code) — required because bash runs traps only between commands, so a foreground (non-backgrounded) child would defer the trap until it exited.
- Restart loop: marker present (deleted) → sleep 2s, restart; exit code `75` → sleep 2s, restart; anything else → exit with that code.

#### `docker-compose.yml`
Single service `ws-scrcpy-web`, builds from the repo `Dockerfile`, overridable image tag (`${WSSW_IMAGE:-ws-scrcpy-web:local}`), port mapping `127.0.0.1:8123:8000` (bound to loopback only — never a bare `8123:8000`, which would expose on every host interface), named volume `wsdata:/data`, env var `WS_SCRCPY_ALLOW_REMOTE_ADMIN` passed through (not defaulted — omitted entirely unless the host has it set, since `requireOperator` sees every containerized request as off-box and setting it makes anyone reachable an administrator).

### 16. Dev supervisor (`scripts/dev-supervisor.mjs`)

Node-side mirror of the Rust supervisor for `npm start` — **never shipped** (`stage-publish.mjs` excludes `scripts/`). Spawns `node dist/index.js` directly.
- `decideRestart(exitCode, markerExists)`: identical precedence to Rust — marker wins over `exitCode === 75`.
- Marker path: `computeMarkerPath` — Windows `%PROGRAMDATA%\WsScrcpyWeb\.restart`; non-Windows: **repo-root** `.restart` (not XDG-resolved — a deliberate dev-mode simplification distinct from the production Rust path).
- Node binary resolution mirrors `spawn.rs::resolve_node_with` exactly: `<dataRoot>/dependencies/node/node[.exe]` first (Windows dataRoot only check shown), else `<repo>/seed/node/node[.exe]`. No system-Node fallback — fatal error with remediation instructions if neither exists. Re-resolved every loop iteration (post-restart, the first run's auto-installed deps-Node takes precedence over seed).
- Crash-loop guard: aborts if **4 or more respawns occur within a 10s window** (`MAX_RESPAWNS_IN_WINDOW=3`, checked as `recentRespawns.length > 3`).
- `RESPAWN_DELAY_MS=250`, `SHUTDOWN_GRACE_MS=10000`.
- Signal handling: POSIX forwards the signal to the child and starts a grace-timer force-kill (`process.kill(-pid, 'SIGKILL')` on the process group, or the plain pid as fallback); on Windows relies on console-group signal propagation (no forward) because `subprocess.kill('SIGINT')` on Win32 is `TerminateProcess` (abrupt, no graceful handler) and is redundant given PowerShell's Ctrl+C already broadcasts to the console group. A second signal during the grace window skips straight to `taskkill /T /F` (Windows) / SIGKILL (POSIX).

### 17. Release artifacts (Linux + Docker) — `.github/workflows/release.yml`, `docker-publish.yml`

**Installer-release artifacts (`release.yml`, `build-linux` job + `publish` job)**:
- `*.AppImage` — the Linux binary.
- `*.AppImage.sig` — detached signature placeholder (signing not yet wired; `FUTURE SIGNER` step commented out; currently unsigned, so this file is absent until a signer lands).
- `*.nupkg` — Velopack update package for in-app updates.
- `releases.linux-<channel>.json` — Velopack feed file (`<channel>` = `beta` or `stable`).
- `SHA256SUMS` — generated over every `*.msi`, `*.AppImage`, `*.AppImage.sig`, `*-Portable.zip`, `*.nupkg`, `*.tar.gz` found under `artifacts/`.
- `artifacts/suite/*.tar.gz` + `.sha256` — the Playwright e2e-suite bundle (qa-harness consumption, not an end-user artifact).
- Build-provenance attestation (Sigstore, `actions/attest-build-provenance`) over `Releases/*.AppImage`, verifiable via `gh attestation verify <artifact>.AppImage --repo bilbospocketses/ws-scrcpy-web`. No checksum/provenance currently exists for a code-signature (none is produced).
- Releases are **never** marked `prerelease: true` (channel separation is done entirely via the per-channel feed file; marking prerelease would hide betas from the updater's release-list reader, and the resolver treats a prerelease as retracted).

**Docker artifacts (`docker-publish.yml`, triggered on the same `v*` tag push, a fully separate workflow)**:
- Single `linux/amd64` platform image (no arm64/QEMU emulation; Google publishes no arm64 scrcpy-server build).
- Docker Scout gate: image built+loaded locally first (`tags: ws-scrcpy-web:scout-gate`), scanned (`docker/scout-action`, `only-severities: critical,high`, `only-fixed: true`, `exit-code: true`) — **any fixable critical/high CVE fails the publish** before anything reaches a registry.
- Pushed (after the gate passes, rebuilt from cache with `provenance: true`, `sbom: true`) to three namespaces per `.github/scripts/docker-tags.mjs`: `docker.io/bilbospocketses` (canonical), `ghcr.io/bilbospocketses` (mirror), and `docker.io/jchapz30` (deprecated, auto-stops publishing after **2026-12-09** with no code change needed — the cutoff is a date comparison, not a flag). Tag set per namespace: the immutable `<version>` tag always first, plus channel tags — `latest`+`stable` for a non-`-beta` version, `beta` for a `-beta` version. A beta build **never** receives `latest` (unit-tested invariant).
- `SHA256SUMS` does **not** cover the Docker image (images are content-addressed by registry digest instead; `docs/RELEASING.md` step 9 verifies the pulled channel-tag digest equals the immutable version-tag's digest across both Hub and GHCR).

[Some lines truncated to 768 chars. Use agent://LauncherScout:raw:101-101 to read line 101 whole; cut lines run to line 130, each read the same way]


## B.8 Public API, embedding, build outputs


### 1. `WsScrcpy.startStream(container, deviceId, options)` — canonical public API

**Source:** `src/app/public/startStream.ts`, `src/app/public/types.ts`

#### 1.1 Signature

```ts
function startStream(container: HTMLElement, deviceId: string, options?: StartStreamOptions): StreamHandle
```

- `container: HTMLElement` — mount point. Marked with the attribute `data-ws-scrcpy-active="1"` (`startStream.ts:17`) while a stream is live; cleared by `stop()`.
- `deviceId: string` — ADB serial or `ip:port`. **Required.**
- `options: StartStreamOptions = {}` — see §1.2.
- Returns `StreamHandle` synchronously — see §1.4.

#### 1.2 `StartStreamOptions` (full field list, `types.ts`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | `string` | `location.hostname` (via `ParamsStreamScrcpy.hostname = options.host ?? ''`, empty string resolved later by the connection layer) | Server hostname. |
| `port` | `number` | `0` → resolved to current location | Server port. |
| `secure` | `boolean` | `false` | Use `wss://`/`https://` when `true`. |
| `pathname` | `string` | `''` | HTTP path prefix for the WS endpoint. |
| `codec` | `'h264'\|'h265'\|'av1'\|'vp8'\|'vp9'` | auto (smart selection) | Forces `videoCodec`. Auto order: H.265 → H.264 → AV1 → VP8 → VP9, filtered by device encoder list ∩ browser `VideoDecoder.isConfigSupported`. VP8/VP9 sit last deliberately (low-end-device fallback; doc TECHNICAL_GUIDE.md:§6.3). |
| `encoder` | `string` | auto | Forces `encoderName`, e.g. `'c2.mtk.hevc.encoder'`. Should be paired with a matching `codec`. |
| `bitrate` | `number` | `8000000` (used only if any of bitrate/maxFps/maxSize given) | bits/sec. |
| `maxFps` | `number` | `15` (same condition) | Frame-rate cap. |
| `maxSize` | `number` | `0` (unbounded, same condition) | Longest-dimension pixel bound; builds a square `Size(maxSize, maxSize)` bound. |
| `audio` | `boolean` | unset → `audioEnabled` omitted from params, server defaults apply (effectively `true`, force-disabled on Android ≤10) | `true`/`false` maps straight to `audioEnabled`. |
| `audioSource` | `'playback'\|'output'\|'mic'` | `'output'` (scrcpy default) | `playback` requires Android 13+, uses `--audio-dup` to keep device audio alive; `output` silences device during session; `mic` captures device microphone. |
| `audioCodec` | `'opus'\|'aac'\|'flac'\|'raw'` | `'opus'` | `aac` is the documented Opus-encoder-failure fallback. |
| `keyboard` | `boolean` | `true` | Capture + forward keyboard input from `container`. |
| `deviceKind` | `'phone'\|'tablet'\|'tv'` | unset → toolbar defaults to D-pad | Seeds the stream toolbar's D-pad/Touch default (D-pad for TV, Touch for phone/tablet). |
| `onConnect` | `(info: StreamInfo) => void` | — | Lifecycle callback, §1.3. |
| `onDisconnect` | `(reason?: string) => void` | — | Lifecycle callback, §1.3. |
| `onError` | `(err: Error) => void` | — | Lifecycle callback, §1.3. |

Internally, `fitToScreen` is always forced `true` (`startStream.ts:60`) — video always scales to the container, preserving aspect ratio; this is not configurable.

#### 1.3 Lifecycle callback semantics (verified in code + `docs/TECHNICAL_GUIDE.md:§6.5`)

- **`onConnect(info)`** — fires once, when session metadata arrives (not first decoded frame — no such signal exists). `info: { codec: string; encoder: string; resolution: string }` are the *actual resolved* values. Sets `handle.isConnected = true`.
- **`onDisconnect(reason?)`** — fires once on a normal end: explicit `stop()`, or WS close code `1000`/`1001`/`1005`. Sets `isConnected = false`.
- **`onError(err)`** — fires on (a) startup failure (device probe failure, WS refused — synchronous `try/catch` around `StreamClientScrcpy.start`, `startStream.ts:107-113`), or (b) abnormal stream end: any other close code including server's `4005` (failed session) and `1006` (dropped connection). `err.message` is the close reason or `"WebSocket closed with code <N>"`.
- **Exactly one of `onError`/`onDisconnect` fires per end** — never both, decided by `StreamClientScrcpy.onDisconnected`.
- A startup failure (`catch` block) calls `onError` **only** — does not also throw and does not call `onDisconnect`. `startStream()` still returns a handle (`isConnected: false`, `stop()` is a no-op, container attribute removed so a retry on the same container is not refused).

#### 1.4 `StreamHandle`

```ts
interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}
```
- `stop()` — closes WS, disposes decoder + audio worklet, empties container, removes `data-ws-scrcpy-active`. **Idempotent** (internal `stopped` flag, `startStream.ts:117-121`).
- `isConnected` — `false` until `onConnect` fires, `false` again once stream ends (any cause).
- `deviceId` — always echoes the input arg, regardless of connect success.

#### 1.5 Synchronous throw conditions

- `deviceId` falsy or non-string → throws `Error('startStream: deviceId is required')` — no handle returned, no callback fires (`startStream.ts:27-29`).
- `container` already carries `data-ws-scrcpy-active` → throws `Error('startStream: deviceId is required')`... actually: `Error('startStream: container already has an active stream; call stop() first')` (`startStream.ts:30-32`). Caller must call `stop()` on the prior handle first.

#### 1.6 Other exports — UMD/ESM entry (`src/app/public/index.ts`)

| Export | Type | Notes |
|---|---|---|
| `startStream` | function | §1.1 |
| `version` | `string` | Injected at build time via webpack `DefinePlugin` (`__WSSCRCPY_VERSION__`) from `package.json` version. |
| `Theme` | type | `'dark' \| 'light'` |
| `ThemeEmbedOptions` | type | See §3. |
| `getTheme` | `() => Theme` | §3. |
| `setTheme` | `(theme: Theme) => void` | §3. |
| `installThemeEmbedListener` | `(opts?) => () => void` | §3. |
| `notifyThemeChanged` | `(target?, opts?) => void` | §3. |
| `notifyThemeReady` | `(target?, opts?) => void` | §3. |
| `StartStreamOptions`, `StreamHandle`, `StreamInfo` | types | §1.2/1.4. |

The entry also side-effect-registers the default player: `StreamClientScrcpy.registerPlayer(WebCodecsPlayer)` (`index.ts:10`) so `startStream` works standalone even if the home page hasn't registered it. `WebCodecsPlayer.isSupported()` returns `typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function'` — i.e. **browser support requirement: the WebCodecs API** (Chromium-family browsers; no Safari/Firefox support as of this codebase's targets `[unverified for exact browser/version matrix beyond the API check]`).

### 2. `embed.html` — zero-config iframe wrapper

**Source:** `public/embed.html`, `src/app/public/embed-entry.ts`

#### 2.1 Page structure

- Transparent body (`background: transparent`) so an iframe host can place its own background.
- A `#status` overlay (fixed top-left, monospace, semi-transparent dark background) with class `hidden` to disappear.
- `<body data-embed-entry>` — the explicit opt-in marker; `embed-entry.ts` only self-bootstraps when this attribute is present (so the same bundle can be imported in tests without side effects).
- Loads `ws-scrcpy.umd.js` then `embed.js` in sequence (relies on the UMD script installing `window.WsScrcpy` first).

#### 2.2 URL parameter → `StartStreamOptions` mapping (`embed-entry.ts: parseEmbedParams`)

| URL Param | Type | Default | Validation |
|---|---|---|---|
| `device` | string | **required** | Missing → error shown, no stream attempted. |
| `host` | string | unset (falls to current location downstream) | passthrough string. |
| `encoder` | string | unset | passthrough string. |
| `pathname` | string | unset | passthrough string. |
| `codec` | string | auto | Must be one of `h264,h265,av1,vp8,vp9` (`CODECS` set) else ignored. |
| `deviceKind` | string | unset | Must be one of `phone,tablet,tv` (`DEVICE_KINDS` set) else ignored. |
| `audioSource` | string | unset | Must be one of `playback,output,mic` (`AUDIO_SOURCES` set) else ignored. |
| `audioCodec` | string | unset | Must be one of `opus,aac,flac,raw` (`AUDIO_CODECS` set) else ignored. |
| `port` | int | unset | `parseInt(v,10)`; `NaN` → not set (falls to default). |
| `bitrate` | int | unset | same parse rule. |
| `maxFps` | int | unset | same parse rule. |
| `maxSize` | int | unset | same parse rule. |
| `secure` | bool | unset | Only exact strings `"true"`/`"false"` set the flag; anything else leaves it unset. |
| `audio` | bool | unset | same `"true"`/`"false"` rule. |
| `keyboard` | bool | unset | same `"true"`/`"false"` rule. |

Unknown params are silently ignored (forward compatible).

#### 2.3 Status overlay behavior (`embed-entry.ts: bootstrap`)

- Initial: `"connecting..."`.
- `missing required "device" param"` (red, `isError=true`) when `device` absent — no stream attempted.
- On `onConnect(info)`: shows `` `connected · ${info.codec} · ${info.resolution}` `` then `setTimeout(hide, 2000)`.
- On `onDisconnect(reason?)`: shows `` `disconnected${reason ? ` (${reason})` : ''}` `` in red, stays visible.
- On `onError(err)`: shows `` `error: ${err.message}` `` in red, stays visible.
- If `window.WsScrcpy` is not present (UMD script failed/missing): shows `'error: WsScrcpy library not loaded (expected ws-scrcpy.umd.js to run first)'`.
- A synchronous throw from `startStream` (e.g. bad deviceId) is caught and shown as `` `error: ${err.message}` ``.

### 3. Theme embed bridge (postMessage protocol)

**Source:** `src/app/public/themeEmbed.ts`, consumed by `src/app/client/ThemeToggle.ts` (persistence lives there, not in this module) and exercised in `tests/e2e/embed-trust.spec.ts` (§10.16).

#### 3.1 `ThemeEmbedOptions`

```ts
interface ThemeEmbedOptions {
    messageType?: string;              // default 'ws-scrcpy-web:theme'
    allowedOrigins?: '*' | string[] | (() => '*' | string[]);  // default '*'
}
```
`allowedOrigins` may be a function, re-evaluated **per message** — lets the app start locked down and widen once `/api/config`'s real allowlist answers, rather than starting open.

#### 3.2 Message types (base type `ws-scrcpy-web:theme` unless overridden)

| Direction | Message `type` | Payload | Trigger |
|---|---|---|---|
| iframe → parent | `<base>-ready` | `{ type, theme: Theme }` | `notifyThemeReady(target?, opts?)` — handshake sent on load (no-op if not embedded, i.e. `target === window`). Always `targetOrigin: '*'` (parent origin unknown at handshake time; payload non-sensitive). |
| parent → iframe | `<base>-request` | `{ type }` | Parent asking for current theme; iframe answers with a fresh `<base>-ready` targeted at `event.origin`. |
| parent → iframe | `<base>` (bare) | `{ type, theme: Theme }` | Parent pushes a theme. Applied via `setTheme()` (DOM attribute only — **not persisted** to DB) if `theme` is a valid `Theme` (`'dark'|'light'`) and origin is allowed. |
| iframe → parent | `<base>-changed` | `{ type, theme: Theme }` | `notifyThemeChanged(target?, opts?)` — sent when the app's *own* UI (theme toggle) changes the theme, so host can mirror it. Always `targetOrigin: '*'`. |

#### 3.3 `installThemeEmbedListener(opts?)`

- Installs a single `window.addEventListener('message', handler)`; returns the matching teardown function.
- Per message: resolves `allowedOrigins` (calling it if it's a function); if not `'*'` and `event.origin` not in the list → message silently dropped.
- Rejects non-object `event.data` or unrecognized `type`.
- Only an approved origin's bare `<base>` message changes the live theme; **an unapproved origin's message is ignored** (verified `embed-trust.spec.ts` §10.16).

### 4. Embed-consent flow (another local app asking to be allowed to frame the app)

**Source:** `src/server/security/embedRequests.ts`, `src/server/api/EmbedRequestApi.ts`, `src/server/security/frameGuard.ts`, client: `src/app/client/EmbedRequestModal.ts`, `src/app/client/EmbedRequestPrompt.ts`.

#### 4.1 Design split

- **Asking** is unauthenticated (no token) but can only raise a prompt — never touches config.
- **Granting** requires: loopback source **and** admin, through the admin-gated API, driven by a human clicking Approve.
- A browser page cannot ask at all: `fetch()` always sends `Origin`, and the origin guard rejects cross-origin non-GET requests on `/embed-request`.
- Exactly **one** request pending at a time; a new `createRequest` call replaces any existing one.
- TTL: `REQUEST_TTL_MS = 5 * 60 * 1000` (5 minutes) — lazily expired on next read (`expireIfStale`).

#### 4.2 Server data model (`embedRequests.ts`)

```ts
type EmbedRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'unknown';
interface EmbedRequest { id: string; origin: string; appName: string; createdAt: number; }
```
- `createRequest(origin, appName)` — normalizes origin via `parseFrameAncestorOrigin` (null → request refused); `appName` trimmed to 64 chars, falls back to `'An application'` if blank; returns `null` if origin unusable (including any IPv6 literal — refused outright, not shown as approvable, since browsers discard IPv6 `frame-ancestors` sources).
- `getPendingRequest()` — the prompt for the approval UI (expires stale first).
- `getStatus(id)` — outcome lookup for the asking app; `'unknown'` if id doesn't match current.
- `findPendingRequest(id)` — read without deciding (used so approval can persist-then-resolve atomically).
- `resolveRequest(id, approved)` — records decision; refuses (`null`) if id doesn't match a currently-pending request.
- `cancelRequest(id)` — withdrawal by the asking app; only succeeds while still pending.

#### 4.3 HTTP routes (`EmbedRequestApi.ts`)

| Method | Path | Gate | Request body | Response | Notes |
|---|---|---|---|---|---|
| `POST` | `/embed-request` | Loopback only (`isLoopback(remoteAddress)`) | `{ origin: string, appName: string }` | `200 {id, status:'pending'}` / `400 {error}` / `403 {error:'embed requests are accepted from this machine only'}` | Origin must be `http(s)` with no path/query/fragment; IPv6 host → `400 { error: IPV6_EMBEDDER_ERROR }`; else generic `400 { error: 'origin must be an http(s) origin with no path' }`. |
| `POST` | `/embed-request/{id}/cancel` | Loopback only | — | `200 { id, cancelled: boolean, status }` / `403` | Withdraws own pending request; cannot undo a decision already made. |
| `GET` | `/embed-request/{id}` | Ungated | — | `200 { id, status }` | Malformed percent-escape in id → `200 { id: raw, status: 'unknown' }` (never 500). |
| `GET` | `/api/embed-request` | Loopback **and** admin (`requireLocalAdmin`) | — | `200 { request: EmbedRequest \| null }` / `403 { error: EMBED_DECIDED_LOCALLY_ERROR }` | Feeds the approval UI poller. |
| `POST` | `/api/embed-request/decision` | Loopback **and** admin | `{ id: string, approved: boolean }` | `200 {status:'denied'}` / `200 {status:'approved', origin}` / `409 {error:'no pending request with that id'}` / `500 {error:'could not apply the approved origin'}` | Approval persists origin to `Config` (`addFrameAncestor`) *before* `resolveRequest` marks it approved; a failed write leaves it pending rather than lying. |
| `GET` | `/api/embed-origins` | Loopback + admin | — | `200 { origins: string[] }` | Settings → Embedding list. |
| `POST` | `/api/embed-origins/revoke` | Loopback + admin | `{ origin: string }` | `200 { origins: string[] }` / `404 {error:'that origin is not currently allowed to embed this app'}` | Takes effect immediately on the running server. |

`EMBED_DECIDED_LOCALLY_ERROR = 'embed permission is decided on this machine only'`. The ungated pair (`/embed-request`, `/embed-request/{id}`) sits deliberately outside `/api` (token coverage is `/api`-only; a foreign native app has no token cookie) but remains Host-allowlisted.

#### 4.4 Origin validation rules (`frameGuard.ts: parseFrameAncestorOrigin`)

Shared by config.json loading, the consent API, and Settings pre-approval. Accepted: `http:`/`https:` URL, no path/query/fragment, no `*`, host matches `/^[a-z0-9.-]+$/` after URL-normalization (lowercase, IDNA punycode, IPv4 canonicalized). Raw value is first rejected if it contains any of `*;,\s"'`` ` (regex `/[*;,\s"'`]/`). Bracketed IPv6 literals refused (`isIpv6FrameAncestor` reports this specific case with `IPV6_EMBEDDER_ERROR`: *"browsers don't accept ipv6 addresses for embedding; use a hostname (such as localhost) or an ipv4 address."*).

#### 4.5 Response headers (`frameGuard.ts: securityHeaders`)

- Always: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`.
- If any origin approved: adds `Content-Security-Policy: frame-ancestors 'self' <approved origins space-separated>`. CSP Level 2 browsers ignore `X-Frame-Options` when both headers present; older browsers fall back to the stricter `SAMEORIGIN`.
- Approving an origin also relaxes cookie `SameSite` policy (to `None; Secure; Partitioned` under HTTPS) so authenticated sessions work inside the approved frame — gated on `hasFrameAncestors()`.

#### 4.6 Client-side approval UI

**`src/app/client/EmbedRequestPrompt.ts`:**
- `startEmbedRequestWatch(callerIsLocal?)` — polls `GET /api/embed-request` every `POLL_INTERVAL_MS = 5000`ms. Skipped entirely if `callerIsLocal === false`. On a `403` response, calls `stopEmbedRequestWatch()` (never retries after being told it's not local-admin). A `Set<string> handled` prevents re-raising the same request id once shown/answered. Only one prompt open at a time (`promptOpen` guard).
- `stopEmbedRequestWatch()` — clears the interval.
- On seeing a pending request not yet `handled`: opens `EmbedRequestModal.ask(...)`. After the user decides `'approved'`/`'denied'`, posts `POST /api/embed-request/decision { id, approved }`. `'expired'`/`'cancelled'` outcomes send **no** decision (server already moved the request out of pending).

**`src/app/client/EmbedRequestModal.ts`** (extends `Modal`):
- Title: `"allow embedding?"`, `dismissible: false` — no close button, Escape/backdrop ignored; only the two footer buttons (`deny`, `approve`) or expiry/withdrawal close it.
- Body: intro sentence naming `appName`; the requesting **origin shown verbatim** on its own monospace line; a warning that approving "saves it to your config" and to "only approve if you recognize it and started the request yourself"; a live countdown `"This request expires in M:SS."` ticking every 1s.
- While open, polls `pollStatus()` (wired to `GET /embed-request/{id}`) every 3000ms; if status becomes `'cancelled'`, the dialog turns into a one-button acknowledgement: *"`{appName}` withdrew this request, so there is nothing left to decide. It was not granted permission to embed this app."* with hint *"Ask again from that app if you still want to allow it."*
- On countdown reaching 0: same acknowledgement pattern but message *"The five-minute window to approve this request has timed out. `{appName}` was not granted permission to embed this app."*
- Resolves one of `'approved' | 'denied' | 'cancelled' | 'expired'`.

#### 4.7 Pre-approval via Settings → Embedding (no dedicated route)

- Staged client-side as `frameAncestorsAdd`, applied by `SettingsBatchApi` on Save, under the **same** admin-and-loopback rule (`EMBED_DECIDED_LOCALLY_ERROR`) and the same `parseFrameAncestorOrigin` validation as §4.3/§4.4. Add row accepts address + port with a scheme toggle (http/https), refuses bad input inline, and never stages a duplicate (per `settings-embedding.spec.ts` / smoke 10.22-10.23).
- Revocation: Settings → Embedding lists approved origins with a **revoke** action that asks for confirmation before calling `POST /api/embed-origins/revoke`.

### 5. Build outputs / dist layout

**Source:** `webpack/ws-scrcpy-web.common.ts`, `.dev.ts`, `.prod.ts`, `scripts/build-types.js`.

`npm run build` (= `npm run clean` + `webpack --config webpack/ws-scrcpy-web.prod.ts` + `npm run build:types`) emits a **5-config array** (`[front, back, libUmd, libEsm, embed]`), each sharing `common()`'s module rules (swc-loader for `.ts/.tsx` → ES2022, `asset/source` for SVG, `asset/resource` for png/jpg/gif, CSS via `mini-css-extract-plugin` for front/lib-UMD or `style-loader` for lib-ESM) and extensions `['.tsx','.ts','.js']`.

| Config | Entry | Output | Notes |
|---|---|---|---|
| `front` | `src/app/index.ts` | `dist/public/bundle.js`, `dist/public/bundle.css` | Also copies `public/index.html`→`dist/public/index.html`, `assets/tray-icon.png`→`dist/public/favicon.png`, and `public/help/*`→`dist/public/help/`. Performance budget: `maxAssetSize: 400_000`, `maxEntrypointSize: 500_000`. |
| `back` | `src/server/index.ts` | `dist/index.js` | Node target; `externals: /^[a-z@]/` (commonjs); emits a generated `dist/package.json` (`name, version, scripts.start, dependencies: {node-pty, ws}`) via `GenerateDistPackageJsonPlugin`; `__PATHNAME__` DefinePlugin'd to `'/'`. |
| `libUmd` | `src/app/public/index.ts` | `dist/public/ws-scrcpy.umd.js` | `output.library: { name: 'WsScrcpy', type: 'umd' }`, `globalObject: 'globalThis'`. Also emits `dist/public/ws-scrcpy.css`. |
| `libEsm` | `src/app/public/index.ts` (same source) | `dist/public/ws-scrcpy.esm.js` | `experiments.outputModule: true`, `output.library: { type: 'module' }`; CSS rule swapped to `style-loader` (no separate CSS extraction for ESM). |
| `embed` | `src/app/public/embed-entry.ts` | `dist/public/embed.js` | Also copies `public/embed.html`→`dist/public/embed.html`. |

After webpack, `npm run build:types` (`scripts/build-types.js`) runs `dts-bundle-generator` programmatically against `src/app/public/index.ts` + `tsconfig.json`, writing `dist/public/ws-scrcpy.d.ts`.

**Full `dist/public/` artifact list relevant to embedding:** `index.html`, `bundle.js`, `bundle.css`, `favicon.png`, `help/*.html`, `ws-scrcpy.umd.js`, `ws-scrcpy.esm.js`, `ws-scrcpy.css`, `ws-scrcpy.d.ts`, `embed.html`, `embed.js`.

`dev.ts` produces the identical 5-config array with `devtool: 'inline-source-map'`, `mode: 'development'`.

`package.json` has **no** `"main"`/`"exports"`/`"files"` field — the library is not published to npm; consumption is from a running server's own `dist/public/` (same-origin `<script src>`/`import`), per `docs/superpowers/specs/2026-04-17-stream-api-design.md` §2 Non-Goals.

#### 5.1 Relevant `package.json` scripts

| Script | Command | Purpose |
|---|---|---|
| `build` | `clean && webpack --config webpack/ws-scrcpy-web.prod.ts … && build:types` | Production build, all 5 outputs + `.d.ts`. |
| `build:dev` | `clean && webpack --config webpack/ws-scrcpy-web.dev.ts …` | Dev build (no `.d.ts` step). |
| `build:types` | `node scripts/build-types.js` | Standalone `.d.ts` regeneration. |
| `clean` | `rm -rf dist` | — |
| `start` | `stage-seed && build && node scripts/dev-supervisor.mjs` | Full local run. |
| `start:no-supervisor` | `build && node dist/index.js` | Run server directly. |
| `test` | `vitest run` | Unit tests, incl. `startStream.test.ts`, `embedEntry.test.ts`, `themeEmbed.test.ts`. |
| `test:e2e` | `playwright test` | Full e2e suite, incl. embed-consent/trust specs. |
| `test:e2e:docker` | `playwright test --config playwright.docker.config.ts` | Containerized e2e tier. |

`engines.node: ">=24"`.

### 6. Help pages (`public/help/*.html`), linked via `src/app/client/helpLink.ts`

- `help/subnets.html` — Subnet & CIDR cheat sheet (linked as `SUBNETS_HELP_HREF = 'help/subnets.html'` from scan/add-subnet dialogs); covers CIDR table (/16–/32), RFC1918 private ranges, 3 accepted address-entry formats in the "add subnet" dialog (CIDR, single IP as `/32`, IP range `a.b.c.d-e` or `a.b.c.d-a.b.c.e` within one `/24`), and what the scan does (mDNS discovery + TCP:5555 probe + `adb connect` confirm, read-only).
- `help/certificate-subject.html` — TLS "Subject Name" explainer; OS-specific CA-install instructions (Windows/macOS/Linux Ubuntu+Fedora/Android/iOS/Firefox) for the self-signed CA the app can generate (Settings → Local HTTPS → download `ws-scrcpy-web-local-ca.crt`).
- Both pages are static (no server DB access) and theme themselves from `?theme=light|dark` on the URL (falling back to `prefers-color-scheme`), because the app's own theme now lives in the settings DB, not `localStorage`.
- `helpLink.ts`: `withHelpTheme(href, theme = getTheme())` rewrites/overwrites the `theme` query param (preserving other params/hash); `themeHelpLink(link, href)` binds `click`/`auxclick`/`contextmenu` listeners so the href is recomputed at *follow* time (theme may have changed since the dialog opened), not build time.
- Copied into `dist/public/help/` by `CopyHelpDirPlugin` in the front webpack config.

### 7. Behavioral checklist — `tests/e2e` spec titles

```
auth.spec.ts
auth-admin.spec.ts
a11y-theming.spec.ts
config-overrides.spec.ts
confirm-dialogs.spec.ts
container-https.spec.ts
container-lifecycle.spec.ts
container-publish.spec.ts
container-user.spec.ts
dependencies-panel.spec.ts
dependencies-restart.spec.ts
devices-ui.spec.ts
docker-gating.spec.ts
embed-consent.spec.ts
embed-trust.spec.ts
first-run-and-reminders.spec.ts
framing-headers.spec.ts
global-setup.ts
insecure-origin.spec.ts
lifecycle.spec.ts
local-https.spec.ts
local-https-fast.spec.ts
mkcert-provenance.spec.ts
responsive-reflow.spec.ts
server-api.spec.ts
server-surface.spec.ts
…
device/streaming.spec.ts
```
…

…
- Exact minimum browser version matrix for WebCodecs beyond the `typeof VideoDecoder === 'function'` feature check is `[unverified]` — no explicit version gate exists in code.

[Showing lines 1-300 of 360. Use :301 to continue]

