#!/usr/bin/env bash
# 本地开发环境一键重启：relay dev server + web dev server + proxy serve daemon。
# 不自动启动 Claude/Codex 交互终端；脚本完成后在当前 shell 里运行：
#   pnpm proxy -- claude
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$HOME/.dev-anywhere/logs"
LOG_RETENTION="50"
RELAY_PORT="3100"
WEB_PORT="5173"
# 默认空：未显式指定 --profile/--relay 时由 resolve-dev-profile.mjs 按 URL 在
# ~/.dev-anywhere/config.json 里解析，避免和具体名字（"local"/"dev"/...）耦合。
DEV_RELAY=""
DEV_PROFILE=""

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev-restart.sh [--profile <name>] [--relay <name>] [--relay-port <port>] [--web-port <port>]

Defaults:
  --profile  auto-resolved from config (whichever profile points at the local relay URL)
  --relay    auto-resolved from config (whichever relay url == ws://localhost:<relay-port>)
  --relay-port 3100
  --web-port 5173
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --profile)
      DEV_PROFILE="${2:-}"
      [[ -n "$DEV_PROFILE" ]] || { echo "ERROR: missing value for --profile" >&2; exit 2; }
      shift 2
      ;;
    --profile=*)
      DEV_PROFILE="${1#--profile=}"
      shift
      ;;
    --relay)
      DEV_RELAY="${2:-}"
      [[ -n "$DEV_RELAY" ]] || { echo "ERROR: missing value for --relay" >&2; exit 2; }
      shift 2
      ;;
    --relay=*)
      DEV_RELAY="${1#--relay=}"
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
    --web-port)
      WEB_PORT="${2:-}"
      [[ -n "$WEB_PORT" ]] || { echo "ERROR: missing value for --web-port" >&2; exit 2; }
      shift 2
      ;;
    --web-port=*)
      WEB_PORT="${1#--web-port=}"
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

for port in "$RELAY_PORT" "$WEB_PORT"; do
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ports must be numeric" >&2
    exit 2
  fi
done

if [[ -z "$DEV_PROFILE" || -z "$DEV_RELAY" ]]; then
  resolved="$(node "$ROOT/scripts/lib/resolve-dev-profile.mjs" --relay-url "ws://localhost:$RELAY_PORT")" || exit $?
  eval "$resolved"
  : "${DEV_PROFILE:=$RESOLVED_PROFILE}"
  : "${DEV_RELAY:=$RESOLVED_RELAY}"
  unset RESOLVED_PROFILE RESOLVED_RELAY
fi

mkdir -p "$LOG_DIR"
LOG_RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"

FONT_DIR="$HOME/.dev-anywhere/relay-data/fonts"
PACKAGE_FONT_DIR="$ROOT/apps/proxy/assets/fonts"

kill_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return
  fi
  echo "Stopping $label on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Force stopping $label on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
    kill -9 $pids 2>/dev/null || true
  fi
}

wait_port() {
  local port="$1"
  local label="$2"
  local log_file="$3"
  for _ in $(seq 1 50); do
    if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$label ready on :$port (log: $log_file)"
      return
    fi
    sleep 0.1
  done
  echo "ERROR: $label failed to listen on :$port. Log: $log_file" >&2
  tail -n 80 "$log_file" 2>/dev/null || true
  exit 1
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

start_detached() {
  local cwd="$1"
  local log_file="$2"
  shift 2
  if command -v screen >/dev/null 2>&1; then
    local session_name
    session_name="dev-anywhere-$(basename "$cwd")-$(date +%s)-$RANDOM"
    screen -dmS "$session_name" bash -lc \
      'cd "$1" && log_file="$2" && shift 2 && exec "$@" >"$log_file" 2>&1 </dev/null' \
      _ "$cwd" "$log_file" "$@"
    return
  fi

  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" >"$log_file" 2>&1 </dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
}

if [ ! -d "$FONT_DIR/sarasa-fixed-sc" ] && [ -d "$PACKAGE_FONT_DIR/sarasa-fixed-sc" ]; then
  echo "Installing bundled font shards to ~/.dev-anywhere"
  mkdir -p "$FONT_DIR"
  cp -R "$PACKAGE_FONT_DIR/sarasa-fixed-sc" "$FONT_DIR/"
fi

WEB_SCHEME="http"
if [[ -n "${DEV_ANYWHERE_WEB_HTTPS_CERT:-}" || -n "${DEV_ANYWHERE_WEB_HTTPS_KEY:-}" ]]; then
  WEB_SCHEME="https"
fi

echo ""
echo "=== Building shared protocol package ==="
pnpm --filter @dev-anywhere/shared run build

echo ""
echo "=== Restarting relay ==="
kill_port "$RELAY_PORT" "relay"
RELAY_LOG="$(prepare_run_log "$LOG_DIR/relay-dev.log")"
start_detached "$ROOT/apps/relay" "$RELAY_LOG" env PORT="$RELAY_PORT" "$ROOT/node_modules/.bin/tsx" src/index.ts
wait_port "$RELAY_PORT" "Relay" "$RELAY_LOG"

echo ""
echo "=== Restarting web ==="
kill_port "$WEB_PORT" "web"
WEB_LOG="$(prepare_run_log "$LOG_DIR/web-dev.log")"
start_detached "$ROOT/apps/web" "$WEB_LOG" env DEV_ANYWHERE_WEB_RELAY_TARGET="http://127.0.0.1:$RELAY_PORT" "$ROOT/apps/web/node_modules/.bin/vite" --host 0.0.0.0 --port "$WEB_PORT"
wait_port "$WEB_PORT" "Web" "$WEB_LOG"

echo ""
echo "=== Restarting proxy serve daemon (profile=$DEV_PROFILE, relay=$DEV_RELAY) ==="
INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- \
  --profile "$DEV_PROFILE" serve restart --relay "$DEV_RELAY"

echo ""
echo "=== All services restarted ==="
echo "  Log run: $LOG_RUN_ID"
echo "  Relay: http://localhost:$RELAY_PORT"
echo "  Web:   $WEB_SCHEME://localhost:$WEB_PORT"
echo "  Proxy profile: $DEV_PROFILE"
echo "  Proxy relay: $DEV_RELAY"
echo ""
echo "Check local chain health:"
echo "  pnpm dev:health -- --profile $DEV_PROFILE --relay-port $RELAY_PORT --web-port $WEB_PORT"
echo ""
echo "Start a real PTY session in your terminal:"
echo "  pnpm --filter @dev-anywhere/proxy run dev -- --profile $DEV_PROFILE claude"
