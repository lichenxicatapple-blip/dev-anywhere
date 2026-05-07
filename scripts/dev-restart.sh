#!/usr/bin/env bash
# 本地开发环境一键重启：relay dev server + web dev server + proxy serve daemon。
# 不自动启动 Claude/Codex 交互终端；脚本完成后在当前 shell 里运行：
#   pnpm proxy -- claude
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${DEV_ANYWHERE_LOG_DIR:-$HOME/.dev-anywhere/logs}"
mkdir -p "$LOG_DIR"
DEV_ANYWHERE_LOG_RUN_ID="${DEV_ANYWHERE_LOG_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
DEV_ANYWHERE_LOG_RETENTION="${DEV_ANYWHERE_LOG_RETENTION:-50}"
export DEV_ANYWHERE_LOG_RUN_ID
export DEV_ANYWHERE_LOG_RETENTION

RELAY_PORT="${DEV_ANYWHERE_RELAY_PORT:-3100}"
WEB_PORT="${DEV_ANYWHERE_WEB_PORT:-5173}"
LEGACY_FONT_DIR="$HOME/.cc-anywhere/relay-data/fonts"
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
  run_file="$dir/${stem}-${DEV_ANYWHERE_LOG_RUN_ID}.log"

  if [ -e "$stable_file" ] && [ ! -L "$stable_file" ]; then
    mv "$stable_file" "$dir/${stem}-legacy-${DEV_ANYWHERE_LOG_RUN_ID}.log"
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
  local keep="$DEV_ANYWHERE_LOG_RETENTION"
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

if [ ! -d "$FONT_DIR/sarasa-fixed-sc" ] && [ -d "$LEGACY_FONT_DIR/sarasa-fixed-sc" ]; then
  echo "Migrating font shards from ~/.cc-anywhere to ~/.dev-anywhere"
  mkdir -p "$FONT_DIR"
  cp -R "$LEGACY_FONT_DIR/sarasa-fixed-sc" "$FONT_DIR/"
elif [ ! -d "$FONT_DIR/sarasa-fixed-sc" ] && [ -d "$PACKAGE_FONT_DIR/sarasa-fixed-sc" ]; then
  echo "Installing bundled font shards to ~/.dev-anywhere"
  mkdir -p "$FONT_DIR"
  cp -R "$PACKAGE_FONT_DIR/sarasa-fixed-sc" "$FONT_DIR/"
fi

echo ""
echo "=== Building shared protocol package ==="
pnpm --filter @dev-anywhere/shared run build

echo ""
echo "=== Restarting relay ==="
kill_port "$RELAY_PORT" "relay"
RELAY_LOG="$(prepare_run_log "$LOG_DIR/relay-dev.log")"
start_detached "$ROOT/apps/relay" "$RELAY_LOG" env PORT="$RELAY_PORT" "$ROOT/apps/relay/node_modules/.bin/tsx" src/index.ts
wait_port "$RELAY_PORT" "Relay" "$RELAY_LOG"

echo ""
echo "=== Restarting web ==="
kill_port "$WEB_PORT" "web"
WEB_LOG="$(prepare_run_log "$LOG_DIR/web-dev.log")"
start_detached "$ROOT/apps/web" "$WEB_LOG" "$ROOT/apps/web/node_modules/.bin/vite" --host 0.0.0.0 --port "$WEB_PORT"
wait_port "$WEB_PORT" "Web" "$WEB_LOG"

echo ""
echo "=== Restarting proxy serve daemon ==="
INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- serve restart

echo ""
echo "=== All services restarted ==="
echo "  Log run: $DEV_ANYWHERE_LOG_RUN_ID"
echo "  Relay: http://localhost:$RELAY_PORT"
echo "  Web:   http://localhost:$WEB_PORT"
echo ""
echo "Check local chain health:"
echo "  pnpm dev:health"
echo ""
echo "Start a real PTY session in your terminal:"
echo "  pnpm proxy -- claude"
