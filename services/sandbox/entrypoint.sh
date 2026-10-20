#!/bin/sh
# Red sandbox entrypoint: validate env, hand the token to execd, start execd as
# PID 1 (init mode) with Caddy as its entrypoint process.
set -eu

fail() {
  echo "sandbox: $*" >&2
  exit 64
}

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
EXECD_PORT="${EXECD_PORT:-44772}"
COGNI_REPO_SHA="${COGNI_REPO_SHA:-${BUILD_SHA:-unknown}}"

case "$PORT" in '' | *[!0-9]*) fail "PORT must be numeric" ;; esac
case "$EXECD_PORT" in '' | *[!0-9]*) fail "EXECD_PORT must be numeric" ;; esac
[ "$PORT" != "$EXECD_PORT" ] || fail "PORT and EXECD_PORT must differ"
case "$HOST" in '' | *[!0-9a-fA-F.:]*) fail "HOST must be an IP literal" ;; esac
# buildSha is rendered into JSON; accept only a hex SHA or the literal fallback.
case "$COGNI_REPO_SHA" in
  unknown) ;;
  '' | *[!0-9a-f]*) fail "COGNI_REPO_SHA must be a lowercase hex git SHA" ;;
esac

# Fail closed: never expose an unauthenticated execd.
TOKEN="${SANDBOX_EXECD_TOKEN:-}"
[ -n "$TOKEN" ] || fail "SANDBOX_EXECD_TOKEN is required; refusing to start an unauthenticated execd"
[ "${#TOKEN}" -ge 32 ] || fail "SANDBOX_EXECD_TOKEN must be at least 32 characters"

# execd reads EXECD_ACCESS_TOKEN and strips it from every workload it launches.
# Drop the platform-named copy so user commands never inherit it.
export EXECD_ACCESS_TOKEN="$TOKEN"
unset SANDBOX_EXECD_TOKEN TOKEN
export PORT HOST EXECD_PORT COGNI_REPO_SHA
export EXECD_INIT=1

exec /usr/local/bin/execd --init --port "$EXECD_PORT" \
  --isolation-config /etc/sandbox/execd.toml -- \
  /usr/local/bin/caddy run --config /etc/sandbox/Caddyfile --adapter caddyfile
