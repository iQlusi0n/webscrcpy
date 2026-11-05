# syntax=docker/dockerfile:1
# Build: docker build -t webscrcpy .
# Run (host adb daemon, preferred):  see docker-compose.yml
# Run (USB passthrough):             docker run --device /dev/bus/usb -p 127.0.0.1:8000:8000 -v wsdata:/data webscrcpy

FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends adb ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 app && useradd -r -u 1000 -g 1000 -m -d /data -s /usr/sbin/nologin app
COPY --from=build /src/dist/webscrcpy /usr/local/bin/webscrcpy
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV PORT=8000 \
    DATA_ROOT=/data \
    HOME=/data \
    APP_DOCKER=1 \
    ADB_PATH=/usr/bin/adb
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/usr/local/bin/webscrcpy", "--healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/bin/webscrcpy"]
