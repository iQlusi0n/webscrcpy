# scrcpy-server v5.0 — Protocol Reference

Derived from Genymobile/scrcpy at tag `v5.0` (Apache-2.0): `doc/develop.md`, `app/src/control_msg.{h,c}`, `app/src/device_msg.{h,c}`, `app/src/util/binary.h`, `server/.../Options.java`, `device/DesktopConnection.java`, `device/Streamer.java`. Written for building a client against the **vanilla** server (design decision D1). The protocol is explicitly internal to scrcpy and changes between versions; the server refuses to start unless the first argument equals its own version string exactly.

All multi-byte integers are **big-endian** unless noted.

---

## 1. Launch

```
adb push scrcpy-server /data/local/tmp/scrcpy-server.jar
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 5.0 [key=value ...]
```

- `args[0]` = client version. Must equal `BuildConfig.VERSION_NAME` (`"5.0"`) or the server throws.
- Remaining args are `key=value`, order irrelevant, unknown keys log a warning and are ignored.
- `/data/local/tmp` is used because it is `shell`-writable but not world-writable.
- With `cleanup=true` (default) the server deletes its own jar on exit. The incumbent sets `cleanup=false` on SDK < 28 because self-delete raced ART class loading.

### 1.1 Options (`Options.parse`)

Only keys relevant to a mirroring client are listed; camera/virtual-display keys are omitted.

| Key | Type | Default | Notes |
|---|---|---|---|
| `scid` | hex int32 ≥ -1 | `-1` | Socket name becomes `scrcpy_<%08x>`; `-1` → plain `scrcpy`. Use a random 31-bit value per session. |
| `log_level` | `verbose\|debug\|info\|warn\|error` | `debug` | Case-insensitive. |
| `video` | bool | `true` | |
| `audio` | bool | `true` | |
| `control` | bool | `true` | |
| `video_codec` | `h264\|h265\|av1\|vp8\|vp9` | `h264` | |
| `audio_codec` | `opus\|aac\|flac\|raw` | `opus` | |
| `video_source` | `display\|camera` | `display` | |
| `audio_source` | `output\|mic\|playback\|...` | `output` | `playback` requires Android 13+. |
| `audio_dup` | bool | `false` | Keep audio playing on device while capturing (Android 13+). |
| `max_size` | int | `0` | Longest dimension cap; 0 = unbounded. |
| `min_size_alignment` | 1,2,4,8,16 | `1` | |
| `video_bit_rate` | int | `8000000` | |
| `audio_bit_rate` | int | `128000` | |
| `max_fps` | float | `0` | 0 = unbounded. |
| `angle` | float | `0` | Rotation angle applied to capture. |
| `tunnel_forward` | bool | `false` | See §2. |
| `crop` | `w:h:x:y` | none | |
| `display_id` | int | `0` | |
| `show_touches` | bool | `false` | |
| `stay_awake` | bool | `false` | |
| `screen_off_timeout` | int ≥ -1 | `-1` | |
| `video_codec_options` | `key[:type]=value,...` | none | Passed to `MediaFormat`. |
| `audio_codec_options` | same | none | |
| `video_encoder` | string | device default | `MediaCodec` encoder name. |
| `audio_encoder` | string | device default | |
| `power_off_on_close` | bool | `false` | |
| `clipboard_autosync` | bool | `true` | Device → client clipboard pushes (§6.1). |
| `downsize_on_error` | bool | `true` | Retry encoder at smaller size on failure. |
| `cleanup` | bool | `true` | Self-delete jar on exit. |
| `power_on` | bool | `true` | Wake screen on start. |
| `capture_orientation` | `[@][0\|90\|180\|270\|flip0...]` | unlocked | `@` prefix locks. |
| `list_encoders` / `list_displays` / `list_cameras` / `list_apps` | bool | `false` | Print and exit; no sockets opened. |
| `send_device_meta` | bool | `true` | 64-byte device name on first socket (§2.2). |
| `send_frame_meta` | bool | `true` | 12-byte frame headers (§3.2). |
| `send_dummy_byte` | bool | `true` | Dummy byte on forward tunnels (§2.1). |
| `send_stream_meta` | bool | `true` | Codec id + session packets (§3.1). |
| `raw_stream` | bool | `false` | `true` disables all four `send_*`. |

---

## 2. Connection

Up to three Unix-domain sockets on the device, abstract name `scrcpy` or `scrcpy_<scid>`, bridged by adb. Opened in order **video, audio, control**; disabled ones are skipped, so with `audio=false` the order is video then control. At least one must be enabled.

### 2.1 Tunnel direction

**Reverse (default, `tunnel_forward=false`)** — the host listens, the device connects:
```
adb reverse localabstract:scrcpy_<scid> tcp:<hostPort>
```
The server calls `connect()` for each enabled socket in order. The host must `accept()` N times (N = enabled count) and assign them in order. Reverse is preferred because there is no race: the listener exists before the server starts.

**Forward (`tunnel_forward=true`)** — the device listens, the host connects:
```
adb forward tcp:<hostPort> localabstract:scrcpy_<scid>
```
The host `connect()`s N times in order. Because `adb forward` accepts the TCP connection even before the device side is listening, the server writes **one dummy byte `0x00` on the first socket opened** (`send_dummy_byte=true`). The host must read and discard it; a read timeout means the server is not up. Needed on old devices where `adb reverse` is unreliable (the incumbent uses forward for SDK < 28).

### 2.2 Device meta

On the **first** enabled socket (whichever that is), after the dummy byte if any, the server sends exactly **64 bytes**: the device name as UTF-8, truncated at a character boundary to ≤ 63 bytes, zero-padded. (`send_device_meta=true`.)

---

## 3. Video and audio sockets

### 3.1 Stream meta (`send_stream_meta=true`)

Each media socket begins with a **u32 codec id**:

| Stream | Codec | ID |
|---|---|---|
| video | h264 | `0x68323634` (`"h264"`) |
| video | h265 | `0x68323635` |
| video | av1 | `0x00617631` |
| video | vp8 | `0x00767038` |
| video | vp9 | `0x00767039` |
| audio | opus | `0x6F707573` |
| audio | aac | `0x00616163` |
| audio | flac | `0x666C6163` |
| audio | raw | `0x00726177` |

On the **audio** socket two reserved values replace the codec id (`Streamer.writeDisableStream`):
- `0x00000000` — audio disabled by the device (could not capture); continue with video only.
- `0x00000001` — configuration error; stop the session.

On the **video** socket, after the codec id and again on every capture-session change (rotation, fold, resize), a **12-byte session packet**:

```
offset 0  u32  flags: bit31 = 1 (session packet marker), bit0 = client-resized (flex displays)
offset 4  u32  video width
offset 8  u32  video height
```
Audio has no session packets.

### 3.2 Media packets (`send_frame_meta=true`)

Every `MediaCodec` output buffer is prefixed by a 12-byte header:

```
offset 0  u64  ptsAndFlags
offset 8  u32  packetSize
offset 12 ...  packetSize bytes of raw codec output
```

Flag bits in `ptsAndFlags` (`Streamer.java`):

| Bit | Mask | Meaning |
|---|---|---|
| 63 | `0x8000000000000000` | **session packet** — only ever set in the 12-byte session packet above; a media packet never has it. Since both start with 8 bytes, read 8 bytes, test bit 63: set → the remaining 4 bytes you already have are width-high... no: set → the 12 bytes are `flags(4) width(4) height(4)`; clear → `pts(8)` then read `size(4)`. |
| 62 | `0x4000000000000000` | **config packet** (`BUFFER_FLAG_CODEC_CONFIG`): SPS/PPS/VPS, AV1 sequence header, Opus/FLAC header. PTS field is otherwise 0. |
| 61 | `0x2000000000000000` | **key frame** (`BUFFER_FLAG_KEY_FRAME`). |
| 0–60 | `0x1FFFFFFFFFFFFFFF` | PTS in microseconds (`presentationTimeUs`). |

Practical parse: read 8 bytes → if bit 63 set, read 4 more (height) and treat `[flags,width,height]`; else read 4 more (size) then `size` bytes.

Config-packet payload fixes applied **server-side** before sending (so the client receives decoder-ready extradata):
- **Opus**: Android's CSD is `AOPUSHDR` + u64 LE length + `OpusHead...` (+ `AOPUSDLY`, `AOPUSPRL` sections); the server strips to the 19-byte `OpusHead` slice.
- **FLAC**: strips the `fLaC` marker + 4-byte BE length, sends the STREAMINFO block only.
- H.264/H.265/AV1: sent as-is (Annex-B SPS/PPS for H.26x). WebCodecs needs these converted to `avcC`/`hvcC` `description`, or fed in-band with `avc1`-style config; the incumbent builds `description` from the config packet once per configure.

Frames are only produced when the screen changes (`KEY_REPEAT_PREVIOUS_FRAME_AFTER` mitigates); a static screen means **no packets**, not zero-length ones.

---

## 4. Control socket — client → device

Bidirectional. Client writes **control messages**; device writes **device messages** (§6) on the same socket. Max message size 256 KiB (`SC_CONTROL_MSG_MAX_SIZE = 1<<18`).

Every message starts with a 1-byte type. Serialization from `control_msg.c`:

| Type | Name | Payload layout | Size |
|---|---|---|---|
| 0 | `INJECT_KEYCODE` | `u8 action; u32 keycode; u32 repeat; u32 metastate` | 14 |
| 1 | `INJECT_TEXT` | `u32 len; utf8[len]` (len ≤ 300) | 5+len |
| 2 | `INJECT_TOUCH_EVENT` | `u8 action; u64 pointerId; u32 x; u32 y; u16 screenW; u16 screenH; u16 pressure(u16fp); u32 actionButton; u32 buttons` | 32 |
| 3 | `INJECT_SCROLL_EVENT` | `u32 x; u32 y; u16 screenW; u16 screenH; i16 hscroll(i16fp); i16 vscroll(i16fp); u32 buttons` | 21 |
| 4 | `BACK_OR_SCREEN_ON` | `u8 action` (BACK key action; screen turns on only on DOWN) | 2 |
| 5 | `EXPAND_NOTIFICATION_PANEL` | — | 1 |
| 6 | `EXPAND_SETTINGS_PANEL` | — | 1 |
| 7 | `COLLAPSE_PANELS` | — | 1 |
| 8 | `GET_CLIPBOARD` | `u8 copyKey` (0 none, 1 copy, 2 cut) | 2 |
| 9 | `SET_CLIPBOARD` | `u64 sequence; u8 paste; u32 len; utf8[len]` (len ≤ 256 KiB − 14) | 10+len |
| 10 | `SET_DISPLAY_POWER` | `u8 on` | 2 |
| 11 | `ROTATE_DEVICE` | — | 1 |
| 12 | `UHID_CREATE` | `u16 id; u16 vendorId; u16 productId; u8 nameLen; utf8[nameLen] (≤127); u16 descLen; bytes[descLen]` | var |
| 13 | `UHID_INPUT` | `u16 id; u16 size; bytes[size]` | 5+size |
| 14 | `UHID_DESTROY` | `u16 id` | 3 |
| 15 | `OPEN_HARD_KEYBOARD_SETTINGS` | — | 1 |
| 16 | `START_APP` | `u8 nameLen; utf8[nameLen] (≤255)` | 2+len |
| 17 | `RESET_VIDEO` | — (forces a new config + keyframe) | 1 |
| 18 | `CAMERA_SET_TORCH` | `u8 on` | 2 |
| 19 | `CAMERA_ZOOM_IN` | — | 1 |
| 20 | `CAMERA_ZOOM_OUT` | — | 1 |
| 21 | `RESIZE_DISPLAY` | `u16 width; u16 height` (flex displays) | 5 |
| 22 | `SCAN_FILE` | `u32 len; utf8[len]` (≤256) — MediaScanner | 5+len |

Types 18–22 are new in 5.0 relative to 4.x; the incumbent (written against 4.x constants) does not use them.

### 4.1 Fixed-point helpers (`binary.h`)

```
u16fp(f)  : f ∈ [0,1]  → u = f * 65536; u >= 0xFFFF ? 0xFFFF : u     (pressure)
i16fp(f)  : f ∈ [-1,1] → i = f * 32768; i >= 0x7FFF ? 0x7FFF : i     (scroll)
```
Scroll: the desktop client accepts raw wheel values in `[-16, 16]`, divides by 16, clamps to `[-1,1]`, then `i16fp`. A browser client should pick its own divisor (the incumbent uses 128 for slower scrolling over latent links) — the device only sees the normalized i16.

### 4.2 Constants

Pointer ids: mouse `UINT64_MAX`, generic finger `UINT64_MAX−1`, virtual finger (pinch) `UINT64_MAX−2`; real touch ids are small integers.

Touch `action`: Android `MotionEvent` — `DOWN=0, UP=1, MOVE=2, CANCEL=3, OUTSIDE=4, POINTER_DOWN=5, POINTER_UP=6, HOVER_MOVE=7, SCROLL=8, HOVER_ENTER=9, HOVER_EXIT=10, BUTTON_PRESS=11, BUTTON_RELEASE=12`. Key `action`: `DOWN=0, UP=1`. `buttons` / `actionButton`: `MotionEvent.BUTTON_*` bitmask (`PRIMARY=1, SECONDARY=2, TERTIARY=4, BACK=8, FORWARD=16`). `metastate`: `KeyEvent.META_*` bitmask. Keycodes: `KeyEvent.KEYCODE_*`.

`screenW/screenH` in touch/scroll must equal the **current video size** (from the latest session packet); the server rejects/mis-scales events for a stale size, which is how rotation-safe input works.

### 4.3 Droppability

`sc_control_msg_is_droppable()`: when the send queue is full the desktop client drops only droppable messages. Non-droppable (must never be lost to keep device state consistent): `INJECT_KEYCODE`, `INJECT_TOUCH_EVENT` (so a DOWN always gets its UP), `UHID_CREATE`/`UHID_DESTROY`, `SET_CLIPBOARD` with sequence. A browser client doing backpressure on the control channel must respect the same rule.

---

## 5. UHID (hardware-level input)

`UHID_CREATE` registers a virtual USB HID device in the kernel via `/dev/uhid`; `UHID_INPUT` sends raw HID reports; `UHID_DESTROY` removes it. Requires Android where `shell` can open `/dev/uhid` (works on most devices; fails silently on some OEM builds). The desktop client uses `vendorId = productId = 0` and standard boot-protocol descriptors:

- **Keyboard**: 63-byte descriptor, 8-byte report `[modifiers, reserved, key1..key6]`. Modifier bits: L-Ctrl 0x01, L-Shift 0x02, L-Alt 0x04, L-Meta 0x08, R-* in the high nibble.
- **Mouse**: relative, 4-byte report `[buttons, dx, dy, wheel]`, int8 deltas ±127.
- **Gamepad** (desktop only): also available; a browser client can add it via the Gamepad API.

The device may send `UHID_OUTPUT` (§6) with output reports (keyboard LEDs); safe to ignore.

---

## 6. Control socket — device → client ("device messages")

Max 256 KiB. Deserialization from `device_msg.c`; messages arrive as a byte stream and **must be reassembled** — a read may contain a partial message or several.

| Type | Name | Payload | Size |
|---|---|---|---|
| 0 | `CLIPBOARD` | `u32 len; utf8[len]` | 5+len |
| 1 | `ACK_CLIPBOARD` | `u64 sequence` | 9 |
| 2 | `UHID_OUTPUT` | `u16 id; u16 size; bytes[size]` | 5+size |

An unknown type is **unrecoverable** (`return -1`): length cannot be known, so the connection must be considered desynchronized. Reject anything ≥ 3.

### 6.1 Clipboard semantics

- With `clipboard_autosync=true`, every device clipboard change produces a `CLIPBOARD` message. `GET_CLIPBOARD` with `copyKey=copy|cut` injects `KEYCODE_COPY`/`KEYCODE_CUT` (API 24+) into the focused app, and the *result* arrives via autosync, not as a direct reply. With `copyKey=none` the server replies with the current clipboard directly.
- `SET_CLIPBOARD` with a non-zero `sequence` is acknowledged by `ACK_CLIPBOARD` carrying the same sequence once the device clipboard is set; `paste=1` additionally injects `KEYCODE_PASTE` (API 24+). Sequence 0 = no ack wanted.

---

## 7. Session lifecycle notes

- Version mismatch, bad option, or encoder failure → server prints to stderr and exits; every socket closes. Treat any socket EOF as session end.
- Rotation: encoder is reset; a new **session packet** then a new **config packet** then a keyframe arrive on the video socket. Reconfigure the decoder; do not reopen audio.
- `RESET_VIDEO` (17) forces the encoder to emit a fresh config + keyframe. Use it after dropping frames (backpressure) or when the decoder has never produced a frame; do not spam it (each call restarts the encoder session).
- `downsize_on_error=true`: if the encoder refuses the requested size, the server retries at a smaller one and emits a new session packet — the client must not assume the first session size is final.
- Keyframe interval is up to the device encoder (`video_codec_options=i-frame-interval:N` is a request, often ignored). Measured on a Pixel: ~1 keyframe / 300 frames for H.264. A missed keyframe is expensive; `RESET_VIDEO` is the recovery.
- Audio: Opus frames are 20 ms at 48 kHz stereo (`audio_bit_rate` default 128 kbps). `raw` = S16LE interleaved stereo 48 kHz with no header. AAC/FLAC need the config packet as decoder `description`; Opus does not.

---

## 8. Minimal client sequence (reverse tunnel, video+audio+control)

1. `adb push scrcpy-server /data/local/tmp/scrcpy-server.jar` (skip if size matches).
2. Listen on an ephemeral `hostPort`; `adb reverse localabstract:scrcpy_<scid> tcp:<hostPort>`.
3. Spawn `app_process ... Server 5.0 scid=<hex> log_level=info video_codec=h265 max_size=1920 ...`.
4. `accept()` ×3 → video, audio, control (10 s timeout).
5. Video socket: read 64 B device name → read u32 codec id → loop: read 8 B; bit 63 set → read 4 B more = session `{flags,w,h}`; else pts/flags → read u32 size → read payload.
6. Audio socket: read u32 codec id (0 = disabled, 1 = error) → loop media packets (no session packets).
7. Control socket: write control messages; concurrently read and reassemble device messages.
8. On close: `adb reverse --remove localabstract:scrcpy_<scid>`; the server exits when its sockets close.
