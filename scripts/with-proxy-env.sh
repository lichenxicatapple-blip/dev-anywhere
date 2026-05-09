#!/usr/bin/env bash
# Run a command with the proxy daemon on a requested env, then restore the previous daemon state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ENV="${1:-}"

if [[ -z "$TARGET_ENV" || "${2:-}" != "--" ]]; then
  echo "usage: scripts/with-proxy-env.sh <env> -- <command> [args...]" >&2
  exit 2
fi
shift 2

if [[ "$#" -eq 0 ]]; then
  echo "usage: scripts/with-proxy-env.sh <env> -- <command> [args...]" >&2
  exit 2
fi

proxy_cli() {
  INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- "$@"
}

ORIGINAL_STATUS="$(proxy_cli serve status 2>&1 || true)"
ORIGINAL_RUNNING=0
ORIGINAL_ENV=""

if printf '%s\n' "$ORIGINAL_STATUS" | grep -q "Service: running"; then
  ORIGINAL_RUNNING=1
  ORIGINAL_ENV="$(
    printf '%s\n' "$ORIGINAL_STATUS" |
      sed -nE 's/^[[:space:]]*Env:[[:space:]]+([^[:space:]]+).*/\1/p' |
      head -n 1
  )"
fi

restore_proxy() {
  local restore_code=$?
  echo ""
  echo "=== Restoring proxy daemon ==="

  if [[ "$ORIGINAL_RUNNING" == "1" && -n "$ORIGINAL_ENV" && "$ORIGINAL_ENV" != "(single)" ]]; then
    proxy_cli serve restart --env "$ORIGINAL_ENV" || true
    proxy_cli serve status || true
  elif [[ "$ORIGINAL_RUNNING" == "1" ]]; then
    proxy_cli serve restart || true
    proxy_cli serve status || true
  else
    proxy_cli serve stop || true
    proxy_cli serve status || true
  fi

  exit "$restore_code"
}

trap restore_proxy EXIT

echo "=== Switching proxy daemon to $TARGET_ENV ==="
proxy_cli serve restart --env "$TARGET_ENV"
proxy_cli serve status

"$@"
