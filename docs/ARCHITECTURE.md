# Architecture & contributor guide

For anyone (human or LLM) changing this codebase. Read `DESIGN_DECISIONS.md` first; this doc is the *how* that follows from those decisions. `SCRCPY_PROTOCOL.md` is authoritative for anything on the device wire.

## 1. Layout

```
src/common/        shared contracts — browser + Bun, Web APIs only, no node:/bun: imports
  scrcpy.ts          scrcpy 5.0 constants: message types, codec ids, flag bits, fixed-point helpers
  protocol.ts        browser⇄server WebSocket contracts: /ws/* endpoints, channel mux, message shapes
  api.ts             HTTP route contract: every path, body and response type
  validate.ts        allowlist validators for every string that reaches adb or device argv
src/server/        Bun server
  app.ts             slice boundary: AppRouter, AppServices, RequestContext, WsHandlers, Gate
  index.ts           composition root + --healthcheck; embed.ts pins browser assets into the binary
  http.ts            Router (Bun.serve fetch+websocket), SocketRegistry, body cap, error envelopes
  security.ts        host allowlist → origin → token cookie → frame headers; X-Forwarded-Proto from loopback only
  config.ts          env > config.json > defaults; data root
  auth/              one optional password: scrypt, lockout, sliding session, mode off|password
  db/                bun:sqlite, PRAGMA user_version migrations, stores
  routes/            config / auth / settings / labels
  adb/               everything that touches a device (registered via registerAdb)
    service.ts         adb discovery, daemon start, AdbServerClient, per-serial Adb cache, one-shot shell
    tracker.ts         host:track-devices → DeviceDescriptor, /ws/devices
    scrcpy.ts          /ws/stream session: options, tunnel, launch, forwarding, congestion, teardown
    tunnel.ts          loopback-only reverse-tunnel listener (Bun.listen) + AdbSocket adapter
    frames.ts          12-byte header parse, channel framing, SocketReader
    congestion.ts      pure shed/resume state machine (4 MiB / 1 MiB)
    options.ts         query → scrcpy argv (non-defaults only), SDK gates, audio fallback
    probe.ts           /ws/probe: wm size/density, encoder lists
    shell.ts           /ws/shell: shell,v2,pty over Tango
    files.ts           /ws/files: sync: list/stat/pull/push with id-prefixed binary frames
    routes.ts          /api/devices/* (connect, screen-state, sleep-wake, files/delete)
    ws.ts              close-with-reason (≤123 B), drain waiter, LiveSockets + shutdown hook
src/app/           browser (vanilla TS, no framework)
  index.ts api.ts    bootstrap, theme first-paint, typed fetch wrapper
  stream/            the stream engine; `startStream(opts): StreamHandle` is its only public surface
    types.ts           slice boundary (StreamOptions / StreamHandle / StreamStats)
    demuxer.ts         WebSocket, channel strip, header parse, device-message reassembly
    codec.ts           WebCodecs probing, SPS/VPS/OBU parsing, avcC/hvcC/av1C, Annex-B→length-prefixed
    video.ts audio.ts  VideoDecoder/canvas with watchdog+recovery; AudioDecoder/worklet
    control.ts         byte-exact encoders for every ControlMsg (tested against upstream vectors)
    input/             pointerState (pure), touch (DOM adapter), dpad, keyboard, text, uhid, clipboard
    toolbar.ts stats.ts dropPush.ts
  ui/                home, device cards/list, modals (configure/stream/shell/files/settings), login
tests/             bun test; pure units only — no device, no network except tests/adb/tunnel (loopback)
assets/scrcpy-server   v5.0 jar, SHA-256 verified against Genymobile's signed SHA256SUMS.txt
contrib/systemd/   example units; Dockerfile + docker-compose.yml at root
```

## 2. Slice contracts (change these deliberately)

Four slices were built in parallel against three frozen interfaces. Keep them stable; extend additively.

| Boundary | File | Consumers |
|---|---|---|
| HTTP + WS shapes | `src/common/api.ts`, `src/common/protocol.ts` | server routes, `src/app/api.ts`, every modal |
| Server composition | `src/server/app.ts` | `src/server/adb/**` sees the server **only** through `AppRouter`/`AppServices` |
| Stream engine | `src/app/stream/types.ts` | `src/app/ui/**` treats `startStream` as a black box |

Rule of thumb: UI never imports from `stream/*` except `index.ts`/`types.ts` (one exception today: `ui/configureModal.ts` imports the encoder matcher from `stream/codec.ts` so there is one codec-naming convention).

## 3. Data flow (one stream)

```
browser ConfigureModal ──/ws/probe──▶ probe.ts ──shell: wm size, dumpsys──▶ device
browser startStream ──/ws/stream?serial&codec…──▶ scrcpy.ts
   scrcpy.ts: validate query → SDK gates → push jar (sync:) → reverse tunnel on 127.0.0.1:0
              → app_process … Server 5.0 key=value → accept video/audio/control
   device ──scrcpy sockets──▶ frames.ts ──[ch][12B hdr][data]──▶ WebSocket ──▶ demuxer.ts
   demuxer ──config pkt──▶ codec.ts (description) ──▶ video.ts VideoDecoder ──▶ canvas
   input/* ──control.ts bytes──▶ [0x02][msg] ──▶ scrcpy.ts ──▶ control socket (raw)
```

Invariants worth knowing before touching this path:
- Media frame headers are forwarded **verbatim**; the server never re-encodes or parses codec data.
- `METADATA` is sent exactly once, before any media; `SESSION` on every rotation; audio opens with a u32 that may be the `0`/`1` sentinel.
- H.264/H.265 chunks must be **re-framed to length-prefixed** before `decode()` because a `description` is configured (`annexBToLengthPrefixed`). AV1/VP8/VP9 pass through.
- Touch sends only `DOWN`/`UP`/`MOVE` per pointer id — never `POINTER_*`/`CANCEL`; scrcpy 5.0 derives the multi-pointer form (`PointerState` is the single source of truth).
- `CONTROL` frames that arrive before the control socket exists are queued (≤64) and flushed after `METADATA`.
- Congestion: never shed config packets; resume only at a keyframe after one `RESET_VIDEO`.
- Reverse tunnel binds loopback only; `tunnelForward` is forced when `ADB_SERVER` is remote (reverse terminates at the adb *server's* loopback).
- Every `release()`/`stop()`/`end()` is idempotent and runs the full teardown; `onError` xor `onDisconnect` fires exactly once.

## 4. Security invariants

Order on every request: `//` in path → 404 · Host allowlist → Origin==Host on `/api` + non-GET → `wsc_token` on `/api/*` (exempt: `GET /api/config`) and **all** WS upgrades → auth gate (`password` mode) → route. Cookies: `wsc_token` Strict, `wsc_sid` Lax; `Secure`/`Partitioned` only when the loopback peer says `X-Forwarded-Proto: https`. Any string bound for adb or device argv passes a `validate.ts` guard first — add a guard, don't add a call site that skips one. Sessionless sockets (mode `off`) are tracked and closed when a password is set.

## 5. Project rules (enforced; CI is `bun run check`)

- Bun ≥ 1.4.2 only. **No native addons, ever.** Nothing with a `.node` binary may be added.
- TypeScript strict + `noUncheckedIndexedAccess`; no `any`; no non-null `!` in `src/` (use guards or `?? 0`); tests may use `!` on fixtures.
- Public types are named and exported from the owning module — never `ReturnType<typeof fn>`.
- Static string lookup tables are `Record<K, V>`; `Set`/`Map` only for dynamic membership.
- No one-line wrapper functions unless the name is a domain contract or a type guard.
- Browser code (`src/app`, `src/common`) imports Web APIs only; `node:`/`bun:` are server-side.
- Biome: 2-space, double quotes, 120 cols, `useImportType`, no unused imports/variables. Suppress a rule only with a reason comment on the exact line (see `scrcpy.ts` FourCC table, `[hidden] !important`).
- Logging to stdout/stderr only (`<ISO> [tag] [LEVEL] msg`); systemd/docker own files and rotation.
- Tests: pure units for protocol/state machines/validators. Don't pin wording or wiring. Anything needing a device is a smoke step, not a test.

## 6. Verification status (as of the last review pass)

**Verified against reality**: control-message encoders byte-exact vs scrcpy's `test_control_msg_serialize.c`; device-message reassembly; every HTTP security layer, auth mode transitions, lockout, socket revocation (4401), shutdown hooks + DB backup — all exercised against the compiled binary with a live adb daemon; UI login/home/settings/theme in headless Chromium with zero console errors.

**Unverified — no Android device was available**: the entire device path. First live test should confirm, in order: device appears via `track-devices` → probe returns encoders → stream shows picture within ~2 s (if not: check `[stream]` log for config packet, then Annex-B reframing) → tap lands where clicked after a rotation → two-finger pinch works → shell prompt → file list of `/sdcard` → upload/download → UHID pointer lock → clipboard both ways → audio.

## 7. How to extend

- **New device feature**: add the message/route shape to `src/common/*` first, then server under `src/server/adb/`, then UI. Validate inputs in `validate.ts`.
- **New scrcpy option**: `options.ts` (emit only when non-default), `StreamQuery` in `protocol.ts`, `DeviceStreamSettings` in `api.ts`, `query.ts` mapping, ConfigureModal field.
- **New scrcpy version**: bump `SCRCPY_VERSION`, replace `assets/scrcpy-server` and verify against the release's `SHA256SUMS.txt`, re-derive `SCRCPY_PROTOCOL.md` from upstream `control_msg.{h,c}` / `device_msg.{h,c}` / `Streamer.java`, re-run `tests/stream/control.test.ts` against the new `test_control_msg_serialize.c` vectors.
- **Deferred features and their triggers** are listed at the end of `V1_SCOPE.md`.
