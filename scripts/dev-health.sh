#!/usr/bin/env bash
# Local dev loop health check: relay + web + proxy serve daemon + recent logs.
# Read-only diagnostics. Run `pnpm dev:restart` first when services need a restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELAY_PORT="3100"
WEB_PORT="5173"
# 默认空：未显式指定时由 resolve-dev-profile.mjs 按 ws://localhost:<relay-port> 在
# config.json 里反查 profile 名。和 dev-restart.sh 保持同一解析口径。
DEV_PROFILE=""
DEV_SERVER_LOG_DIR="$HOME/.dev-anywhere/logs"
PROXY_LOG_DIR=""

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev-health.sh [--profile <name>] [--relay-port <port>] [--web-port <port>]

Defaults:
  --profile  auto-resolved from config (whichever profile points at the local relay URL)
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
      DEV_SERVER_LOG_DIR="${2:-}"
      [[ -n "$DEV_SERVER_LOG_DIR" ]] || { echo "ERROR: missing value for --log-dir" >&2; exit 2; }
      shift 2
      ;;
    --log-dir=*)
      DEV_SERVER_LOG_DIR="${1#--log-dir=}"
      shift
      ;;
    --proxy-log-dir)
      PROXY_LOG_DIR="${2:-}"
      [[ -n "$PROXY_LOG_DIR" ]] || { echo "ERROR: missing value for --proxy-log-dir" >&2; exit 2; }
      shift 2
      ;;
    --proxy-log-dir=*)
      PROXY_LOG_DIR="${1#--proxy-log-dir=}"
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

if [[ -z "$DEV_PROFILE" ]]; then
  resolved="$(node "$ROOT/scripts/lib/resolve-dev-profile.mjs" --relay-url "ws://localhost:$RELAY_PORT")" || exit $?
  eval "$resolved"
  DEV_PROFILE="$RESOLVED_PROFILE"
  unset RESOLVED_PROFILE RESOLVED_RELAY
fi

if [ "$DEV_PROFILE" = "default" ]; then
  DEFAULT_PROXY_LOG_DIR="$HOME/.dev-anywhere/logs"
else
  DEFAULT_PROXY_LOG_DIR="$HOME/.dev-anywhere/profiles/$DEV_PROFILE/logs"
fi
PROXY_LOG_DIR="${PROXY_LOG_DIR:-$DEFAULT_PROXY_LOG_DIR}"
WEB_SCHEME="http"
if [[ -n "${DEV_ANYWHERE_WEB_HTTPS_CERT:-}" || -n "${DEV_ANYWHERE_WEB_HTTPS_KEY:-}" ]]; then
  WEB_SCHEME="https"
fi

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
  if ! output="$(
    INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- \
      --profile "$DEV_PROFILE" serve status 2>&1
  )"; then
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
scan_log "relay dev" "$DEV_SERVER_LOG_DIR/relay-dev.log" "$RELAY_PIDS"
scan_log "web dev" "$DEV_SERVER_LOG_DIR/web-dev.log"
scan_log "proxy service" "$PROXY_LOG_DIR/service.log" "$SERVICE_PID"
scan_log "proxy terminal" "$PROXY_LOG_DIR/terminal.log" "$TERMINAL_PIDS"

section "Manual Smoke"
echo "Open: $WEB_SCHEME://localhost:$WEB_PORT"
echo "Create a real hosted terminal from Web:"
echo "  1. New session -> select Terminal mode -> Agent CLI Claude Code or Codex"
echo "  2. Send a short message; verify per-key input, Shift+Enter, Ctrl+C menu, session terminate"
echo ""
echo "Or attach from local terminal:"
echo "  pnpm --filter @dev-anywhere/proxy run dev -- --profile $DEV_PROFILE claude"
echo "  pnpm --filter @dev-anywhere/proxy run dev -- --profile $DEV_PROFILE codex"

exit "$EXIT_CODE"
