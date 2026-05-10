#!/usr/bin/env bash
# Local chaos runner: inject relay/proxy/web failures and verify reconnect recovery.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$ROOT/scripts/lib/smoke-common.sh"
smoke_use_stable_node

RELAY_PORT="3100"
WEB_PORT="5173"
WEB_BASE_URL=""
LOG_DIR="$HOME/.dev-anywhere/logs"
LOG_RETENTION="50"
# 默认空：未显式指定时由 resolve-dev-profile.mjs 按 ws://localhost:<relay-port> 在
# config.json 里反查 profile/relay 名。和 dev-restart.sh 同口径。
DEV_PROFILE=""
DEV_RELAY=""
LOG_RUN_ID="$(date +%Y%m%d-%H%M%S)-chaos-$$"
RELAY_CHAOS_TYPES="proxy_list_response,proxy_select_response,dir_list_response,proxy_info,session_list,agent_status,agent_status_response,session_history_messages,session_resources_response,pty_state,pending_approvals_push,permission_request_delivered,tool_approve,tool_deny,session_snapshot"
RELAY_CHAOS_DELAY_MS="20"
RELAY_CHAOS_DUPLICATE="1"
RELAY_CHAOS_DUPLICATE_DELAY_MS="20"
RELAY_CHAOS_REORDER="1"
RELAY_CHAOS_REORDER_DELAY_MS="60"
CHAOS_WORKDIR="${TMPDIR:-/tmp}/dev-anywhere-chaos"

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev-chaos.sh [--profile <name>] [--relay <name>] [--relay-port <port>] [--web-port <port>] [--base-url <url>] [--workdir <path>]
                       [--relay-chaos-types <csv>] [--relay-chaos-delay-ms <ms>]
                       [--relay-chaos-duplicate 0|1] [--relay-chaos-duplicate-delay-ms <ms>]
                       [--relay-chaos-reorder 0|1] [--relay-chaos-reorder-delay-ms <ms>]

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
    --base-url)
      WEB_BASE_URL="${2:-}"
      [[ -n "$WEB_BASE_URL" ]] || { echo "ERROR: missing value for --base-url" >&2; exit 2; }
      shift 2
      ;;
    --base-url=*)
      WEB_BASE_URL="${1#--base-url=}"
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
    --workdir)
      CHAOS_WORKDIR="${2:-}"
      [[ -n "$CHAOS_WORKDIR" ]] || { echo "ERROR: missing value for --workdir" >&2; exit 2; }
      shift 2
      ;;
    --workdir=*)
      CHAOS_WORKDIR="${1#--workdir=}"
      shift
      ;;
    --relay-chaos-types)
      RELAY_CHAOS_TYPES="${2:-}"
      [[ -n "$RELAY_CHAOS_TYPES" ]] || { echo "ERROR: missing value for --relay-chaos-types" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-types=*)
      RELAY_CHAOS_TYPES="${1#--relay-chaos-types=}"
      shift
      ;;
    --relay-chaos-delay-ms)
      RELAY_CHAOS_DELAY_MS="${2:-}"
      [[ -n "$RELAY_CHAOS_DELAY_MS" ]] || { echo "ERROR: missing value for --relay-chaos-delay-ms" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-delay-ms=*)
      RELAY_CHAOS_DELAY_MS="${1#--relay-chaos-delay-ms=}"
      shift
      ;;
    --relay-chaos-duplicate)
      RELAY_CHAOS_DUPLICATE="${2:-}"
      [[ -n "$RELAY_CHAOS_DUPLICATE" ]] || { echo "ERROR: missing value for --relay-chaos-duplicate" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-duplicate=*)
      RELAY_CHAOS_DUPLICATE="${1#--relay-chaos-duplicate=}"
      shift
      ;;
    --relay-chaos-duplicate-delay-ms)
      RELAY_CHAOS_DUPLICATE_DELAY_MS="${2:-}"
      [[ -n "$RELAY_CHAOS_DUPLICATE_DELAY_MS" ]] || { echo "ERROR: missing value for --relay-chaos-duplicate-delay-ms" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-duplicate-delay-ms=*)
      RELAY_CHAOS_DUPLICATE_DELAY_MS="${1#--relay-chaos-duplicate-delay-ms=}"
      shift
      ;;
    --relay-chaos-reorder)
      RELAY_CHAOS_REORDER="${2:-}"
      [[ -n "$RELAY_CHAOS_REORDER" ]] || { echo "ERROR: missing value for --relay-chaos-reorder" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-reorder=*)
      RELAY_CHAOS_REORDER="${1#--relay-chaos-reorder=}"
      shift
      ;;
    --relay-chaos-reorder-delay-ms)
      RELAY_CHAOS_REORDER_DELAY_MS="${2:-}"
      [[ -n "$RELAY_CHAOS_REORDER_DELAY_MS" ]] || { echo "ERROR: missing value for --relay-chaos-reorder-delay-ms" >&2; exit 2; }
      shift 2
      ;;
    --relay-chaos-reorder-delay-ms=*)
      RELAY_CHAOS_REORDER_DELAY_MS="${1#--relay-chaos-reorder-delay-ms=}"
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

for numeric_value in "$RELAY_PORT" "$WEB_PORT" "$RELAY_CHAOS_DELAY_MS" "$RELAY_CHAOS_DUPLICATE_DELAY_MS" "$RELAY_CHAOS_REORDER_DELAY_MS"; do
  if ! [[ "$numeric_value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ports and relay chaos delays must be numeric" >&2
    exit 2
  fi
done
for bool_value in "$RELAY_CHAOS_DUPLICATE" "$RELAY_CHAOS_REORDER"; do
  if [[ "$bool_value" != "0" && "$bool_value" != "1" ]]; then
    echo "ERROR: relay chaos booleans must be 0 or 1" >&2
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

WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:$WEB_PORT}"
mkdir -p "$LOG_DIR"
SERVICE_LOG_CURSOR=0
STARTED_PROXY_PID=""
HOSTED_PTY_CHAOS_BIN=""
HOSTED_PTY_CHAOS_CWD="$CHAOS_WORKDIR/hosted-pty"
LOCAL_PTY_CHAOS_BIN=""
LOCAL_PTY_CHAOS_CWD="$CHAOS_WORKDIR/local-pty"
JSON_WORKER_CHAOS_BIN=""
JSON_WORKER_CHAOS_CWD="$CHAOS_WORKDIR/json-worker"

section() {
  echo ""
  echo "=== $1 ==="
}

ok() {
  echo "OK   $1"
}

fail() {
  echo "FAIL $1" >&2
  exit 1
}

run() {
  echo "+ $*"
  "$@"
}

recover_on_failure() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo ""
    echo "=== Chaos failed; restoring dev services ===" >&2
    pnpm dev:restart -- --profile "$DEV_PROFILE" --relay "$DEV_RELAY" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR" --log-retention "$LOG_RETENTION" || true
  fi
  exit "$code"
}
trap recover_on_failure EXIT

wait_until() {
  local label="$1"
  local timeout="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$@"; then
      ok "$label"
      return
    fi
    sleep 0.5
  done
  fail "$label timed out after ${timeout}s"
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
  printf '%s\n' "$run_file"
}

start_detached() {
  local cwd="$1"
  local log_file="$2"
  shift 2
  if command -v screen >/dev/null 2>&1; then
    local session_name
    session_name="dev-anywhere-chaos-$(basename "$cwd")-$(date +%s)-$RANDOM"
    screen -dmS "$session_name" bash -lc \
      'cd "$1" && log_file="$2" && shift 2 && exec "$@" >"$log_file" 2>&1 </dev/null' \
      _ "$cwd" "$log_file" "$@"
    return
  fi

  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" >"$log_file" 2>&1 </dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
}

port_has_listener() {
  lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1
}

port_has_no_listener() {
  ! port_has_listener "$1"
}

relay_http_ok() {
  curl -fsS "http://localhost:$RELAY_PORT/api/status" >/dev/null
}

web_http_ok() {
  curl -fsS "http://localhost:$WEB_PORT/" >/dev/null
}

run_real_ui_smoke() {
  local label="$1"
  echo "+ UI smoke: $label"
  WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- e2e/real-chaos.spec.ts --project=desktop
}

run_relay_down_ui_smoke() {
  echo "+ UI smoke: relay down state"
  DEV_ANYWHERE_EXPECT_RELAY_DOWN=1 WEB_BASE_URL="$WEB_BASE_URL" \
    pnpm --filter @dev-anywhere/web run test:e2e -- e2e/real-chaos.spec.ts --project=desktop
}

run_render_chaos_smoke() {
  echo "+ UI smoke: PTY render-time stale snapshot and duplicate frame handling"
  WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/pty-smoke.spec.ts --project=desktop --grep "stale render"
}

run_protocol_chaos_smoke() {
  echo "+ UI smoke: requestId snapshot and approval recovery chaos"
  WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/protocol-chaos.spec.ts --project=desktop
}

run_websocket_reconnect_chaos_smoke() {
  echo "+ UI smoke: client WebSocket reconnect state recovery"
  WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/websocket-chaos.spec.ts --project=desktop
}

run_real_provider_approval_smoke() {
  echo "+ UI smoke: real Claude/Codex hosted PTY approval"
  DEV_ANYWHERE_REAL_PROVIDER_CWD="$HOSTED_PTY_CHAOS_CWD" \
    WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/real-provider-approval.spec.ts --project=desktop
}

run_hosted_pty_exit_chaos_smoke() {
  local provider="$1"
  echo "+ UI smoke: hosted $provider PTY provider exit while Web is attached"
  DEV_ANYWHERE_HOSTED_PTY_CHAOS=1 \
    DEV_ANYWHERE_HOSTED_PTY_CHAOS_CWD="$HOSTED_PTY_CHAOS_CWD" \
    DEV_ANYWHERE_HOSTED_PTY_CHAOS_PROVIDER="$provider" \
    WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/hosted-pty-chaos.spec.ts --project=desktop
}

run_local_runtime_pty_chaos_smoke() {
  local provider="$1"
  echo "+ UI smoke: local runtime $provider PTY reconnect and detach"
  DEV_ANYWHERE_LOCAL_PTY_CHAOS=1 \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_CWD="$LOCAL_PTY_CHAOS_CWD" \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN="$LOCAL_PTY_CHAOS_BIN" \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_PROVIDER="$provider" \
    WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/real-local-pty-chaos.spec.ts --project=desktop
}

run_json_worker_chaos_smoke() {
  echo "+ UI smoke: real Claude JSON worker approval and relay restart"
  DEV_ANYWHERE_JSON_WORKER_CHAOS=1 \
    DEV_ANYWHERE_JSON_WORKER_CHAOS_CWD="$JSON_WORKER_CHAOS_CWD" \
    WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e -- \
    e2e/real-json-worker-chaos.spec.ts --project=desktop
}

create_hosted_pty_chaos_provider() {
  mkdir -p "$HOSTED_PTY_CHAOS_CWD"
  HOSTED_PTY_CHAOS_BIN="$LOG_DIR/chaos-agent-${LOG_RUN_ID}.sh"
  cat >"$HOSTED_PTY_CHAOS_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '\033]0;DEV Anywhere Chaos Agent\a'
printf 'DEV Anywhere chaos PTY ready\r\n'
printf 'type exit-chaos to terminate\r\n'
buffer=""
while IFS= read -rsn1 ch; do
  case "$ch" in
    $'\r'|$'\n')
      printf '\r\n'
      if [[ "$buffer" == *"exit-chaos"* ]]; then
        printf 'chaos provider exiting now\r\n'
        exit 42
      fi
      buffer=""
      ;;
    $'\003')
      printf '^C\r\n'
      buffer=""
      ;;
    *)
      buffer+="$ch"
      printf '%s' "$ch"
      if [[ "$buffer" == *"exit-chaos"* ]]; then
        printf '\r\nchaos provider exiting now\r\n'
        exit 42
      fi
      ;;
  esac
done
EOF
  chmod +x "$HOSTED_PTY_CHAOS_BIN"
  ok "hosted PTY chaos provider ready: $HOSTED_PTY_CHAOS_BIN"
}

create_local_pty_chaos_provider() {
  mkdir -p "$LOCAL_PTY_CHAOS_CWD"
  LOCAL_PTY_CHAOS_BIN="$ROOT/apps/web/e2e/fixtures/local-pty-chaos-agent.mjs"
  ok "local PTY chaos provider ready: $LOCAL_PTY_CHAOS_BIN"
}

create_json_worker_chaos_provider() {
  mkdir -p "$JSON_WORKER_CHAOS_CWD"
  JSON_WORKER_CHAOS_BIN="$ROOT/apps/web/e2e/fixtures/json-worker-chaos-agent.mjs"
  ok "JSON worker chaos provider ready: $JSON_WORKER_CHAOS_BIN"
}

kill_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    ok "$label already down on :$port"
    return
  fi
  echo "Killing $label on :$port (PID: $(echo "$pids" | tr '\n' ' '))"
  kill -9 $pids 2>/dev/null || true
}

service_status() {
  INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- --profile "$DEV_PROFILE" serve status 2>&1
}

mark_service_log() {
  local service_log="$LOG_DIR/service.log"
  if [ -f "$service_log" ]; then
    SERVICE_LOG_CURSOR="$(wc -l <"$service_log" | tr -d ' ')"
  else
    SERVICE_LOG_CURSOR=0
  fi
}

service_log_since_marker() {
  local service_log="$LOG_DIR/service.log"
  [ -f "$service_log" ] || return 1
  tail -n +"$((SERVICE_LOG_CURSOR + 1))" "$service_log"
}

service_pid() {
  service_status | sed -n 's/.*Service: running (PID \([0-9][0-9]*\)).*/\1/p' | head -n 1
}

proxy_relay_connected() {
  service_status | grep -q "Relay:   connected"
}

service_log_has_relay_connected() {
  service_log_since_marker | grep -Eq '"to":"synced"|Received register response'
}

proxy_relay_connected_observed() {
  if proxy_relay_connected; then
    return 0
  fi
  service_log_has_relay_connected
}

proxy_relay_disconnected() {
  service_status | grep -q "Relay:   disconnected"
}

service_log_has_relay_disconnect() {
  service_log_since_marker | grep -Eq '"to":"waiting_reconnect"|Relay connection closed unexpectedly'
}

proxy_relay_disconnect_observed() {
  if proxy_relay_disconnected; then
    return 0
  fi
  service_log_has_relay_disconnect
}

proxy_service_running() {
  service_status | grep -q "Service: running"
}

started_proxy_process_alive() {
  [ -n "$STARTED_PROXY_PID" ] && kill -0 "$STARTED_PROXY_PID" 2>/dev/null
}

service_log_has_service_started() {
  service_log_since_marker | grep -q '"msg":"Service started"'
}

proxy_service_running_observed() {
  if proxy_service_running; then
    return 0
  fi
  if started_proxy_process_alive; then
    return 0
  fi
  service_log_has_service_started
}

proxy_service_not_running() {
  ! proxy_service_running
}

start_proxy_serve() {
  local output
  local code
  for attempt in 1 2 3; do
    set +e
    output="$(
      env INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- \
        --profile "$DEV_PROFILE" serve start --relay "$DEV_RELAY" 2>&1
    )"
    code=$?
    set -e
    printf '%s\n' "$output"
    STARTED_PROXY_PID="$(
      printf '%s\n' "$output" | sed -n 's/.*Service started in background (PID \([0-9][0-9]*\)).*/\1/p' | tail -n 1
    )"
    if [ "$code" -eq 0 ] && [ -n "$STARTED_PROXY_PID" ]; then
      return 0
    fi
    echo "serve start attempt $attempt failed or did not report a PID; retrying..." >&2
    sleep "$attempt"
  done
  return 1
}

start_relay_only() {
  local chaos="${1:-0}"
  local relay_log
  relay_log="$(prepare_run_log "$LOG_DIR/relay-dev.log")"
  start_detached "$ROOT/apps/relay" "$relay_log" env PORT="$RELAY_PORT" \
    DEV_ANYWHERE_RELAY_CHAOS="$chaos" \
    DEV_ANYWHERE_RELAY_CHAOS_TYPES="$RELAY_CHAOS_TYPES" \
    DEV_ANYWHERE_RELAY_CHAOS_DELAY_MS="$RELAY_CHAOS_DELAY_MS" \
    DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE="$RELAY_CHAOS_DUPLICATE" \
    DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE_DELAY_MS="$RELAY_CHAOS_DUPLICATE_DELAY_MS" \
    DEV_ANYWHERE_RELAY_CHAOS_REORDER="$RELAY_CHAOS_REORDER" \
    DEV_ANYWHERE_RELAY_CHAOS_REORDER_DELAY_MS="$RELAY_CHAOS_REORDER_DELAY_MS" \
    "$ROOT/node_modules/.bin/tsx" src/index.ts
  wait_until "relay listens on :$RELAY_PORT" 10 port_has_listener "$RELAY_PORT"
  wait_until "relay HTTP status responds" 10 relay_http_ok
}

start_web_only() {
  local web_log
  web_log="$(prepare_run_log "$LOG_DIR/web-dev.log")"
  start_detached "$ROOT/apps/web" "$web_log" env DEV_ANYWHERE_WEB_RELAY_TARGET="http://127.0.0.1:$RELAY_PORT" "$ROOT/apps/web/node_modules/.bin/vite" --host 0.0.0.0 --port "$WEB_PORT"
  wait_until "web listens on :$WEB_PORT" 10 port_has_listener "$WEB_PORT"
  wait_until "web HTTP responds" 10 web_http_ok
}

section "Baseline restart"
run pnpm dev:restart -- --profile "$DEV_PROFILE" --relay "$DEV_RELAY" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR" --log-retention "$LOG_RETENTION"
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos 1: relay process crash and reconnect"
mark_service_log
kill_port "$RELAY_PORT" "relay"
wait_until "relay listener is down" 10 port_has_no_listener "$RELAY_PORT"
run_relay_down_ui_smoke
wait_until "proxy observes relay disconnected" 30 proxy_relay_disconnect_observed
start_relay_only
wait_until "proxy reconnects to restarted relay" 30 proxy_relay_connected_observed
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"
run_real_ui_smoke "after relay restart"

section "Chaos 2: proxy serve crash and daemon restart"
pid="$(service_pid)"
if [ -z "$pid" ]; then
  fail "proxy serve PID not found"
fi
echo "Killing proxy serve daemon (PID: $pid)"
kill -9 "$pid" 2>/dev/null || true
wait_until "proxy serve is not running" 10 proxy_service_not_running
mark_service_log
run start_proxy_serve
wait_until "proxy serve is running" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay" 30 proxy_relay_connected_observed
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"
run_real_ui_smoke "after proxy serve restart"

section "Chaos 3: web dev server crash and restart"
kill_port "$WEB_PORT" "web"
wait_until "web listener is down" 10 port_has_no_listener "$WEB_PORT"
start_web_only
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"
run_real_ui_smoke "after web restart"

section "Chaos 4: relay duplicate/reorder/delay with real UI"
kill_port "$RELAY_PORT" "relay"
wait_until "relay listener is down" 10 port_has_no_listener "$RELAY_PORT"
mark_service_log
start_relay_only 1
wait_until "proxy reconnects to chaos relay" 30 proxy_relay_connected_observed
run_real_ui_smoke "under relay duplicate/reorder/delay"
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos 5: PTY render-time stale snapshot and duplicate frames"
run_render_chaos_smoke

section "Chaos 6: protocol snapshot staleness and approval recovery"
run_protocol_chaos_smoke

section "Chaos 7: client WebSocket reconnect state recovery"
run_websocket_reconnect_chaos_smoke

section "Chaos 8: real Claude/Codex hosted PTY approval"
mkdir -p "$HOSTED_PTY_CHAOS_CWD"
run_real_provider_approval_smoke

section "Chaos 9: hosted Claude PTY provider exit while Web is attached"
create_hosted_pty_chaos_provider
mark_service_log
run env CLAUDE_BIN="$HOSTED_PTY_CHAOS_BIN" INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- --profile "$DEV_PROFILE" serve restart --relay "$DEV_RELAY"
wait_until "proxy serve is running with hosted PTY chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after hosted PTY chaos provider swap" 30 proxy_relay_connected_observed
run_hosted_pty_exit_chaos_smoke claude
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos 10: hosted Codex PTY provider exit while Web is attached"
mark_service_log
run env CODEX_BIN="$HOSTED_PTY_CHAOS_BIN" INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- --profile "$DEV_PROFILE" serve restart --relay "$DEV_RELAY"
wait_until "proxy serve is running with hosted Codex PTY chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after hosted Codex PTY chaos provider swap" 30 proxy_relay_connected_observed
run_hosted_pty_exit_chaos_smoke codex
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos 11: local runtime Claude/Codex PTY across serve restart"
create_local_pty_chaos_provider
run_local_runtime_pty_chaos_smoke claude
run_local_runtime_pty_chaos_smoke codex
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos 12: real Claude JSON worker approval across relay restart"
create_json_worker_chaos_provider
mark_service_log
run env CLAUDE_BIN="$JSON_WORKER_CHAOS_BIN" INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- --profile "$DEV_PROFILE" serve restart --relay "$DEV_RELAY"
wait_until "proxy serve is running with JSON worker chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after JSON worker provider swap" 30 proxy_relay_connected_observed
run_json_worker_chaos_smoke
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Restore normal dev services"
run pnpm dev:restart -- --profile "$DEV_PROFILE" --relay "$DEV_RELAY" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR" --log-retention "$LOG_RETENTION"
run pnpm dev:health -- --profile "$DEV_PROFILE" --relay-port "$RELAY_PORT" --web-port "$WEB_PORT" --log-dir "$LOG_DIR"

section "Chaos completed"
ok "real local relay/web/proxy chaos scenarios passed"
