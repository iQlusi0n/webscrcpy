#!/bin/sh
# Fix /data ownership once, then drop to uid 1000. Works when started as root (default)
# or when the operator already runs the container as a non-root uid.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  if [ "$(stat -c '%u' /data)" != "1000" ]; then
    chown -R 1000:1000 /data
  fi
  exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all -- "$@"
fi

if [ ! -w /data ]; then
  echo "/data is not writable by uid $(id -u). Fix with:" >&2
  echo "  docker run --rm -u 0 -v <volume>:/data --entrypoint chown webscrcpy -R $(id -u):$(id -g) /data" >&2
  exit 1
fi
exec "$@"
