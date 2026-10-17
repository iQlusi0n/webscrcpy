# webscrcpy

Android screen mirroring and control from a browser. A single Bun binary pushes Genymobile's vanilla [scrcpy-server](https://github.com/Genymobile/scrcpy) to the phone over ADB and bridges its video/audio/control sockets onto one WebSocket; the browser decodes with WebCodecs and sends touch, keyboard, UHID mouse/keyboard, clipboard and files back.

Inspired by [ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web) (behaviour, not code). Design records live in `docs/` — the short version: Bun, no native addons, no runtime downloads, `adb` is yours, HTTPS is your reverse proxy's job, phones over USB first.

## Requirements

- **`adb`** on the machine running the server: `sudo apt install adb` / `brew install android-platform-tools`. The server starts the daemon if it isn't running (or set `ADB_SERVER=host:port` to use one elsewhere).
- An Android device with USB debugging on (or wireless debugging after a one-time `adb pair` / `adb tcpip 5555`).
- A Chromium-based browser. Streaming needs a **secure context**: `http://localhost:8000` on the server machine, or `https://` through a reverse proxy from anywhere else (see below).

## Run

```sh
# from a release binary
./webscrcpy                      # http://localhost:8000

# from source
bun install
bun run dev                      # builds the web bundle, runs the server with reload
bun run build                    # dist/webscrcpy single-file executable (+ dist/public)
```

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP listen port. Binds all interfaces; put it behind a proxy or bind via firewall. |
| `DATA_ROOT` | `$XDG_DATA_HOME/webscrcpy` → `~/.local/share/webscrcpy` | `config.json`, `webscrcpy.db` |
| `ADB_PATH` | `adb` on `PATH` | explicit binary |
| `ADB_SERVER` | `127.0.0.1:5037` | existing adb daemon (`host:port`); if unset and closed, the server runs `adb start-server` |
| `ALLOWED_HOSTS` | — | comma-separated domain names accepted in the `Host` header (reverse proxy) |
| `APP_DOCKER` | — | `1` inside the image |
| `AUTH_PASSWORD` | — | sets the single login password (not changeable in the UI while set). Omit to set one in Settings, or to run without login behind an authenticating proxy. |

`config.json` (`DATA_ROOT`) carries the same `port`, `allowedHosts`, `frameAncestors`. Env wins over file.

## Access control

One optional password, no user accounts. Two supported setups:

- **Password on** — set `AUTH_PASSWORD` or create one in Settings → Access. Every page, API call and WebSocket then needs the session cookie (30-day sliding; 5 wrong attempts in 5 minutes lock login for 15). Logging out revokes all sessions.
- **Password off** — the app is open to anyone who can reach the port; put an authenticating reverse proxy in front (Traefik forward-auth, Caddy `basic_auth`, nginx `auth_request`, an OIDC proxy). The app never sees credentials in this mode and that is intended: the proxy is the login.

Independently of login, Host allowlisting, Origin checks, a per-launch token cookie and `X-Frame-Options`/`frame-ancestors` defend against DNS rebinding, CSRF and clickjacking.

```caddyfile
devices.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1h;
}
```

## systemd

`contrib/systemd/webscrcpy.service` (user scope, starts at login) and `webscrcpy-system.service` (boot, dedicated user). Copy, edit `ExecStart`, enable.

## Docker

```sh
docker compose up -d
```

USB-first, so the container needs a path to the phone. `docker-compose.yml` shows both: the host runs the adb daemon (`adb -a nodaemon server`) and the container uses `ADB_SERVER=host.docker.internal:5037` (preferred — udev rules stay on the host), or pass `/dev/bus/usb` through and let the in-image `adb` own the device. Everything mutable is on the `/data` volume.

## Features

Device list (live via `track-devices`) · stream with H.264/H.265/AV1/VP8/VP9 + Opus/AAC/FLAC/PCM · touch, scroll, keyboard, text, UHID keyboard+mouse (pointer lock), D-pad mode for TVs · clipboard both ways · screenshot · stats overlay · per-device stream settings · interactive shell (`shell,v2,pty`) · file browser (list/upload/download/delete over `sync:`) · sleep/wake · labels · users, roles, sign-in · dark/light theme.

Not in v1: network scanning, QR pairing, in-app HTTPS, in-app updates, Windows.

## License

MIT. `assets/scrcpy-server` is scrcpy-server v5.0 by Genymobile, Apache-2.0, verified against the release's signed `SHA256SUMS.txt`.
