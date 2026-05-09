#!/usr/bin/env bash
# Start only the Web dev server and point its relay proxy at a selected backend.
# This does not start, stop, or restart any local proxy daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="127.0.0.1"
PORT=""
RELAY_NAME=""
TARGET=""

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev-web.sh --relay <name> --port <port>
  scripts/dev-web.sh --target <relay-url> --port <port>

Examples:
  pnpm dev:web -- --relay local --port 5173
  pnpm dev:web -- --relay cloud --port 5174

The script starts Vite only. It never restarts or switches a proxy daemon.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --relay)
      RELAY_NAME="${2:-}"
      if [[ -z "$RELAY_NAME" ]]; then
        echo "ERROR: missing value for --relay" >&2
        exit 2
      fi
      shift 2
      ;;
    --relay=*)
      RELAY_NAME="${1#--relay=}"
      shift
      ;;
    --target)
      TARGET="${2:-}"
      if [[ -z "$TARGET" ]]; then
        echo "ERROR: missing value for --target" >&2
        exit 2
      fi
      shift 2
      ;;
    --target=*)
      TARGET="${1#--target=}"
      shift
      ;;
    --port)
      PORT="${2:-}"
      if [[ -z "$PORT" ]]; then
        echo "ERROR: missing value for --port" >&2
        exit 2
      fi
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    --host)
      HOST="${2:-}"
      if [[ -z "$HOST" ]]; then
        echo "ERROR: missing value for --host" >&2
        exit 2
      fi
      shift 2
      ;;
    --host=*)
      HOST="${1#--host=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

normalize_http_url() {
  local url="$1"
  url="${url%/}"
  url="${url/#wss:/https:}"
  url="${url/#ws:/http:}"
  printf '%s\n' "$url"
}

read_relay_url_from_config() {
  node - "$1" <<'NODE'
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = `${homedir()}/.dev-anywhere/config.json`;
const relayName = process.argv[2];
try {
  const config = JSON.parse(readFileSync(path, "utf-8"));
  const relayUrl = config.relays?.[relayName]?.url;
  if (!relayUrl) {
    console.error(`Missing relays.${relayName}.url in ${path}`);
    process.exit(2);
  }
  process.stdout.write(relayUrl);
} catch (err) {
  console.error(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
NODE
}

if [[ -n "$TARGET" && -n "$RELAY_NAME" ]]; then
  echo "ERROR: use either --relay or --target, not both" >&2
  usage
  exit 2
fi

if [[ -z "$TARGET" ]]; then
  if [[ -z "$RELAY_NAME" ]]; then
    echo "ERROR: missing --relay <name> or --target <relay-url>" >&2
    usage
    exit 2
  fi
  TARGET="$(read_relay_url_from_config "$RELAY_NAME")"
fi

TARGET="$(normalize_http_url "$TARGET")"

if [[ -z "$PORT" ]]; then
  echo "ERROR: missing --port" >&2
  usage
  exit 2
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --port must be a number" >&2
  exit 2
fi

pick_free_port() {
  local candidate="$1"
  while lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; do
    candidate=$((candidate + 1))
  done
  printf '%s\n' "$candidate"
}

PORT="$(pick_free_port "$PORT")"

cat <<EOF
=== DEV Anywhere web dev ===
Web:          http://$HOST:$PORT
Relay:        ${RELAY_NAME:-custom}
Relay target: $TARGET
Proxy daemon: untouched
Proxy profile: unaffected
EOF

cd "$ROOT/apps/web"
DEV_ANYWHERE_WEB_RELAY_TARGET="$TARGET" exec "$ROOT/apps/web/node_modules/.bin/vite" \
  --host "$HOST" \
  --port "$PORT"
