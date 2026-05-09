#!/usr/bin/env bash
# Restart only the local relay dev server. Proxy serve and Web stay up so chaos tests
# can verify reconnect behavior without resetting provider/session state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELAY_PORT="3100"
LOG_DIR="$HOME/.dev-anywhere/logs"
LOG_RETENTION="50"

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev-relay-restart.sh [--relay-port <port>]

Defaults:
  --relay-port 3100
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --relay-port)
      RELAY_PORT="${2:-}"
      [[ -n "$RELAY_PORT" ]] || { echo "ERROR: missing value for --relay-port" >&2; exit 2; }
      shift 2
      ;;
    --relay-port=*)
      RELAY_PORT="${1#--relay-port=}"
      shift
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      [[ -n "$LOG_DIR" ]] || { echo "ERROR: missing value for --log-dir" >&2; exit 2; }
      shift 2
      ;;
    --log-dir=*)
      LOG_DIR="${1#--log-dir=}"
      shift
      ;;
    --log-retention)
      LOG_RETENTION="${2:-}"
      [[ -n "$LOG_RETENTION" ]] || { echo "ERROR: missing value for --log-retention" >&2; exit 2; }
      shift 2
      ;;
    --log-retention=*)
      LOG_RETENTION="${1#--log-retention=}"
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

if ! [[ "$RELAY_PORT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --relay-port must be numeric" >&2
  exit 2
fi

LOG_RUN_ID="$(date +%Y%m%d-%H%M%S)-relay-$$"
mkdir -p "$LOG_DIR"

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return
  fi
  echo "Stopping relay on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Force stopping relay on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
    kill -9 $pids 2>/dev/null || true
  fi
}

prune_run_logs() {
  local dir="$1"
  local stem="$2"
  local current_file="$3"
  local keep="$LOG_RETENTION"
  if [ "$keep" = "0" ]; then
    return
  fi

  ls -t "$dir/${stem}-"*.log 2>/dev/null |
    grep -vx "$current_file" |
    tail -n +"$keep" |
    xargs rm -f 2>/dev/null || true
}

prepare_run_log() {
  local stable_file="$1"
  local dir
  local base
  local stem
  local run_file
  dir="$(dirname "$stable_file")"
  base="$(basename "$stable_file")"
  stem="${base%.log}"
  run_file="$dir/${stem}-${LOG_RUN_ID}.log"

  if [ -e "$stable_file" ] && [ ! -L "$stable_file" ]; then
    mv "$stable_file" "$dir/${stem}-legacy-${LOG_RUN_ID}.log"
  fi

  ln -sfn "$(basename "$run_file")" "$stable_file"
  : >"$run_file"
  prune_run_logs "$dir" "$stem" "$run_file"
  printf '%s\n' "$run_file"
}

start_detached() {
  local cwd="$1"
  local log_file="$2"
  shift 2
  if command -v screen >/dev/null 2>&1; then
    local session_name
    session_name="dev-anywhere-relay-$(date +%s)-$RANDOM"
    screen -dmS "$session_name" bash -lc \
      'cd "$1" && log_file="$2" && shift 2 && exec "$@" >"$log_file" 2>&1 </dev/null' \
      _ "$cwd" "$log_file" "$@"
    return
  fi

  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" >"$log_file" 2>&1 </dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
}

wait_relay() {
  for _ in $(seq 1 80); do
    if curl -fsS "http://localhost:$RELAY_PORT/api/status" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  echo "ERROR: relay failed to respond on :$RELAY_PORT" >&2
  exit 1
}

kill_port "$RELAY_PORT"
RELAY_LOG="$(prepare_run_log "$LOG_DIR/relay-dev.log")"
start_detached "$ROOT/apps/relay" "$RELAY_LOG" env PORT="$RELAY_PORT" \
  "$ROOT/node_modules/.bin/tsx" src/index.ts
wait_relay
echo "Relay restarted on :$RELAY_PORT (log: $RELAY_LOG)"
