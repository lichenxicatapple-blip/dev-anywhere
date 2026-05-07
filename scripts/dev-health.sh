#!/usr/bin/env bash
# 本地真实链路健康检查：relay + web + proxy serve daemon + 最近日志。
# 只读诊断，不启动/停止进程；需要重启时先运行 `pnpm dev:restart`。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELAY_PORT="${DEV_ANYWHERE_RELAY_PORT:-3100}"
WEB_PORT="${DEV_ANYWHERE_WEB_PORT:-5173}"
LOG_DIR="${DEV_ANYWHERE_LOG_DIR:-$HOME/.dev-anywhere/logs}"

EXIT_CODE=0
RELAY_PIDS=""
WEB_PIDS=""
SERVICE_PID=""
TERMINAL_PIDS=""

section() {
  echo ""
  echo "=== $1 ==="
}

ok() {
  echo "OK   $1"
}

warn() {
  echo "WARN $1"
}

fail() {
  echo "FAIL $1"
  EXIT_CODE=1
}

indent() {
  sed 's/^/  /'
}

check_port() {
  local label="$1"
  local port="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    fail "$label is not listening on :$port"
    return
  fi
  ok "$label listening on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
  case "$label" in
    Relay) RELAY_PIDS="$pids" ;;
    Web) WEB_PIDS="$pids" ;;
  esac
}

check_http() {
  local label="$1"
  local url="$2"
  local body
  if ! body="$(curl -fsS --max-time 2 "$url" 2>/dev/null)"; then
    fail "$label request failed: $url"
    return
  fi
  ok "$label responded: $url"
  printf '%s\n' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const keys = ["status", "proxyCount", "clientCount", "uptime"].filter((key) => key in data);
        const summary = keys.map((key) => `${key}=${data[key]}`).join(", ");
        if (summary) console.log(summary);
      } catch {
        console.log(raw.slice(0, 160));
      }
    });
  ' | indent
}

check_proxy_status() {
  local output
  if ! output="$(INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- serve status 2>&1)"; then
    fail "proxy serve status command failed"
    printf '%s\n' "$output" | indent
    return
  fi

  printf '%s\n' "$output" | indent
  SERVICE_PID="$(printf '%s\n' "$output" | sed -n 's/.*Service: running (PID \([0-9][0-9]*\)).*/\1/p' | head -n 1)"

  if printf '%s\n' "$output" | grep -q "Service: running"; then
    ok "proxy serve daemon is running"
  else
    fail "proxy serve daemon is not running"
  fi

  if printf '%s\n' "$output" | grep -q "Relay:   connected"; then
    ok "proxy serve is connected to relay"
  elif printf '%s\n' "$output" | grep -q "Relay:"; then
    fail "proxy serve is not connected to relay"
  else
    warn "proxy serve status did not include relay state"
  fi
}

detect_terminal_pids() {
  local candidates
  local pid
  local cwd
  candidates="$(
    ps -axo pid=,command= |
      grep -E 'tsx .*apps/proxy/src/index\.ts|tsx src/index\.ts|dev-anywhere( |$)' |
      grep -Ev 'serve status|serve\.ts|relay|web|grep ' |
      awk '{print $1}' || true
  )"
  TERMINAL_PIDS=""
  for pid in $candidates; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    if [ "$cwd" = "$ROOT/apps/proxy" ] || [ "$cwd" = "$ROOT" ]; then
      TERMINAL_PIDS="${TERMINAL_PIDS}${pid}"$'\n'
    fi
  done
  TERMINAL_PIDS="$(printf '%s' "$TERMINAL_PIDS" | sed '/^$/d')"
}

scan_log() {
  local label="$1"
  local file="$2"
  local pid_filter="${3:-}"
  if [ ! -f "$file" ]; then
    warn "$label log missing: $file"
    return
  fi

  ok "$label log exists: $file"
  if [ "$label" = "proxy terminal" ] && [ -z "$pid_filter" ]; then
    ok "$label has no active attached terminal process; skipping historical attach log"
    return
  fi

  local suspicious
  suspicious="$(
    tail -n 300 "$file" 2>/dev/null |
      if [ -n "$pid_filter" ]; then grep -E "\"pid\":($(printf '%s' "$pid_filter" | paste -sd '|' -))\\b" || true; else cat; fi |
      grep -Ei 'invalid .*json|hook .*failed|failed to start|uncaught|eaddrinuse|fatal|panic|error' |
      grep -Eiv 'proxy auth token not set|client auth token not set|ok for dev|NO_COLOR|ws proxy socket error|ECONNRESET|EPIPE' || true
  )"

  if [ -n "$suspicious" ]; then
    warn "$label recent log has suspicious lines:"
    printf '%s\n' "$suspicious" | tail -n 20 | indent
  else
    ok "$label recent log has no obvious startup/hook errors"
  fi
}

section "Ports"
check_port "Relay" "$RELAY_PORT"
check_port "Web" "$WEB_PORT"

section "Relay HTTP"
check_http "Relay health" "http://localhost:$RELAY_PORT/health"
check_http "Relay status" "http://localhost:$RELAY_PORT/api/status"

section "Proxy Serve"
check_proxy_status

section "Logs"
detect_terminal_pids
scan_log "relay dev" "$LOG_DIR/relay-dev.log" "$RELAY_PIDS"
scan_log "web dev" "$LOG_DIR/web-dev.log"
scan_log "proxy service" "$LOG_DIR/service.log" "$SERVICE_PID"
scan_log "proxy terminal" "$LOG_DIR/terminal.log" "$TERMINAL_PIDS"

section "Manual Smoke"
echo "Open: http://localhost:$WEB_PORT"
echo "Create a real hosted PTY from Web:"
echo "  1. 新建会话 -> 交互模式 PTY -> Agent CLI Claude Code 或 Codex"
echo "  2. 输入一条短消息，确认逐键输入、Shift+Enter、Ctrl+C 菜单、终止会话"
echo ""
echo "Or attach from local terminal:"
echo "  pnpm proxy -- --provider claude"
echo "  pnpm proxy -- --provider codex"

exit "$EXIT_CODE"
