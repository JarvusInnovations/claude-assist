#!/usr/bin/env bash
# ExecStartPre helper for claude-assist-server.service.
#
# systemd --user units can't declare After=/Requires= on the system
# docker.service (different manager/namespace), so there is no way to guarantee
# the postgres container is up by the time this unit starts — right after boot,
# for instance, before Docker has finished starting containers. Poll instead.
set -euo pipefail

HOST="127.0.0.1"
PORT="2528"
MAX_ATTEMPTS=30
SLEEP_SECONDS=2

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then
    exit 0
  fi
  echo "wait-for-postgres: ${HOST}:${PORT} not ready (attempt ${attempt}/${MAX_ATTEMPTS})"
  sleep "$SLEEP_SECONDS"
done

echo "wait-for-postgres: gave up after $((MAX_ATTEMPTS * SLEEP_SECONDS))s waiting for ${HOST}:${PORT}" >&2
exit 1
