#!/usr/bin/env bash
# Local chaos runner: inject relay/proxy/web failures and verify reconnect recovery.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
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
EPHEMERAL_PROFILE_DIR=""

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/dev/chaos.sh [--profile <name>] [--relay <name>] [--relay-port <port>] [--web-port <port>] [--base-url <url>] [--workdir <path>]
                       [--ephemeral-profile-dir <path>]
                       [--relay-chaos-types <csv>] [--relay-chaos-delay-ms <ms>]
                       [--relay-chaos-duplicate 0|1] [--relay-chaos-duplicate-delay-ms <ms>]
                       [--relay-chaos-reorder 0|1] [--relay-chaos-reorder-delay-ms <ms>]

Defaults:
  --profile  auto-resolved from config (whichever profile points at the local relay URL)
  --relay    follows an explicit profile's config; auto-resolved when profile is omitted
  --relay-port 3100
  --web-port 5173

Release isolation:
  Pass a freshly-created directory directly below ~/.dev-anywhere/profiles as
  --ephemeral-profile-dir. The directory name must equal --profile and start
  with "release-e2e.". The runner stops its daemon, frees its ports, and removes
  only that directory on both success and failure.
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
    --ephemeral-profile-dir)
      EPHEMERAL_PROFILE_DIR="${2:-}"
      [[ -n "$EPHEMERAL_PROFILE_DIR" ]] || { echo "ERROR: missing value for --ephemeral-profile-dir" >&2; exit 2; }
      shift 2
      ;;
    --ephemeral-profile-dir=*)
      EPHEMERAL_PROFILE_DIR="${1#--ephemeral-profile-dir=}"
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

if [[ -z "$DEV_PROFILE" ]]; then
  resolved="$(node "$ROOT/scripts/lib/resolve-dev-profile.mjs" --relay-url "ws://localhost:$RELAY_PORT")" || exit $?
  eval "$resolved"
  : "${DEV_PROFILE:=$RESOLVED_PROFILE}"
  : "${DEV_RELAY:=$RESOLVED_RELAY}"
  unset RESOLVED_PROFILE RESOLVED_RELAY
fi

if [[ -n "$EPHEMERAL_PROFILE_DIR" ]]; then
  PROFILE_ROOT="$HOME/.dev-anywhere/profiles"
  if [[ "$(dirname "$EPHEMERAL_PROFILE_DIR")" != "$PROFILE_ROOT" || "$(basename "$EPHEMERAL_PROFILE_DIR")" != "$DEV_PROFILE" || "$DEV_PROFILE" != release-e2e.* ]]; then
    echo "ERROR: ephemeral profile must be an exact release-e2e.* directory directly below $PROFILE_ROOT" >&2
    exit 2
  fi
  if [[ ! -d "$EPHEMERAL_PROFILE_DIR" ]]; then
    echo "ERROR: ephemeral profile directory does not exist: $EPHEMERAL_PROFILE_DIR" >&2
    exit 2
  fi
  if [[ -z "${DEV_ANYWHERE_E2E_OWNER_TOKEN:-}" || -L "$EPHEMERAL_PROFILE_DIR/.release-e2e-owner" || ! -f "$EPHEMERAL_PROFILE_DIR/.release-e2e-owner" ]]; then
    echo "ERROR: ephemeral profile ownership marker is missing or unsafe: $EPHEMERAL_PROFILE_DIR" >&2
    exit 2
  fi
  if [[ "$(tr -d '\r\n' <"$EPHEMERAL_PROFILE_DIR/.release-e2e-owner")" != "$DEV_ANYWHERE_E2E_OWNER_TOKEN" ]]; then
    echo "ERROR: ephemeral profile ownership marker does not match: $EPHEMERAL_PROFILE_DIR" >&2
    exit 2
  fi
  if [[ "${DATA_DIR:-}" != "$EPHEMERAL_PROFILE_DIR/relay-data" ]]; then
    echo "ERROR: ephemeral Relay DATA_DIR must be inside its owned profile directory" >&2
    exit 2
  fi
fi

if [[ -n "$DEV_RELAY" ]]; then
  PROXY_RELAY_ARGS=(--relay "$DEV_RELAY")
else
  PROXY_RELAY_ARGS=()
fi

# Real-backend Playwright specs must operate on the same isolated runtime as this
# shell orchestrator. Keep one generic contract for the real-file and Chaos gates.
export DEV_ANYWHERE_E2E_PROFILE="$DEV_PROFILE"
export DEV_ANYWHERE_E2E_RELAY="$DEV_RELAY"
export DEV_ANYWHERE_E2E_RELAY_PORT="$RELAY_PORT"
export DEV_ANYWHERE_E2E_HOOK_PORT="${DEV_ANYWHERE_HOOK_PORT:-}"
export DEV_ANYWHERE_E2E_RELAY_URL="${RELAY_URL:-}"
export DEV_ANYWHERE_E2E_LOG_DIR="$LOG_DIR"

WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:$WEB_PORT}"
mkdir -p "$LOG_DIR"
if [[ "$DEV_PROFILE" == "default" ]]; then
  PROXY_LOG_DIR="$HOME/.dev-anywhere/logs"
else
  PROXY_LOG_DIR="$HOME/.dev-anywhere/profiles/$DEV_PROFILE/logs"
fi
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
  echo "--- proxy serve status ---" >&2
  service_status >&2 || true
  echo "--- proxy service log ---" >&2
  tail -n 120 "$PROXY_LOG_DIR/service.log" >&2 2>/dev/null || true
  echo "--- proxy terminal log ---" >&2
  tail -n 120 "$PROXY_LOG_DIR/terminal.log" >&2 2>/dev/null || true
  exit 1
}

run() {
  echo "+ $*"
  "$@"
}

restart_dev_services() {
  pnpm dev:restart -- \
    --profile "$DEV_PROFILE" \
    ${PROXY_RELAY_ARGS[@]+"${PROXY_RELAY_ARGS[@]}"} \
    --relay-port "$RELAY_PORT" \
    --web-port "$WEB_PORT" \
    --log-dir "$LOG_DIR" \
    --log-retention "$LOG_RETENTION"
}

check_dev_health() {
  pnpm dev:health -- \
    --profile "$DEV_PROFILE" \
    --relay-port "$RELAY_PORT" \
    --web-port "$WEB_PORT" \
    --log-dir "$LOG_DIR" \
    --proxy-log-dir "$PROXY_LOG_DIR"
}

proxy_serve_action() {
  local action="$1"
  pnpm --filter @dev-anywhere/proxy run dev -- \
    --profile "$DEV_PROFILE" serve "$action" ${PROXY_RELAY_ARGS[@]+"${PROXY_RELAY_ARGS[@]}"}
}

ephemeral_pty_screens() {
  local screen_session screen_name
  if ! command -v screen >/dev/null 2>&1; then
    return 0
  fi
  while IFS= read -r screen_session; do
    screen_name="${screen_session#*.}"
    case "$screen_name" in
      "dev-anywhere-local-pty-${DEV_PROFILE}-"*) printf '%s\n' "$screen_session" ;;
    esac
  done < <(screen -ls 2>/dev/null | awk '$1 ~ /^[0-9]+\./ { print $1 }' || true)
}

stop_ephemeral_pty_screens() {
  local screen_session remaining=""
  while IFS= read -r screen_session; do
    [[ -n "$screen_session" ]] || continue
    screen -S "$screen_session" -X quit >/dev/null 2>&1 || true
  done < <(ephemeral_pty_screens)
  for _ in $(seq 1 20); do
    remaining="$(ephemeral_pty_screens)"
    [[ -z "$remaining" ]] && return
    sleep 0.1
  done
  echo "ERROR: isolated local PTY screen did not stop: $remaining" >&2
  return 1
}

cleanup_ephemeral_profile() {
  [[ -n "$EPHEMERAL_PROFILE_DIR" ]] || return
  local source_name source_path

  local stop_output stop_ok=1 pid="" profile_root_real profile_dir_real owner_token

  # The real-local-PTY spec owns these detached screens. End them before stopping
  # the daemon so no surviving test terminal can race to auto-start it again.
  if ! stop_ephemeral_pty_screens; then
    stop_ok=0
  fi

  if ! stop_output="$(INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- \
    --profile "$DEV_PROFILE" serve stop 2>&1)"; then
    stop_ok=0
    echo "ERROR: failed to stop isolated Proxy profile $DEV_PROFILE:" >&2
    printf '%s\n' "$stop_output" >&2
  fi
  if [[ -f "$EPHEMERAL_PROFILE_DIR/run/dev-anywhere.pid" ]]; then
    pid="$(tr -d '[:space:]' <"$EPHEMERAL_PROFILE_DIR/run/dev-anywhere.pid")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      stop_ok=0
      echo "ERROR: isolated Proxy PID $pid is still alive; retaining $EPHEMERAL_PROFILE_DIR" >&2
    fi
  fi

  kill_port "$WEB_PORT" "ephemeral web" || stop_ok=0
  kill_port "$RELAY_PORT" "ephemeral relay" || stop_ok=0
  if [[ -n "${DEV_ANYWHERE_HOOK_PORT:-}" ]]; then
    kill_port "$DEV_ANYWHERE_HOOK_PORT" "ephemeral hook" || stop_ok=0
  fi

  for source_name in service terminal; do
    source_path="$PROXY_LOG_DIR/$source_name.log"
    if [[ -f "$source_path" ]]; then
      if ! cp "$source_path" "$LOG_DIR/proxy-${source_name}-${LOG_RUN_ID}.log"; then
        stop_ok=0
        echo "ERROR: failed to preserve isolated Proxy $source_name log" >&2
      fi
    fi
  done

  if [[ "$stop_ok" != "1" ]]; then
    return 1
  fi
  if [[ ! -e "$EPHEMERAL_PROFILE_DIR" ]]; then
    return
  fi
  if [[ -L "$EPHEMERAL_PROFILE_DIR" ]]; then
    echo "ERROR: refusing to remove symlinked ephemeral profile: $EPHEMERAL_PROFILE_DIR" >&2
    return 1
  fi
  if [[ -L "$EPHEMERAL_PROFILE_DIR/.release-e2e-owner" || ! -f "$EPHEMERAL_PROFILE_DIR/.release-e2e-owner" ]]; then
    echo "ERROR: refusing to remove an unowned ephemeral profile: $EPHEMERAL_PROFILE_DIR" >&2
    return 1
  fi
  owner_token="$(tr -d '\r\n' <"$EPHEMERAL_PROFILE_DIR/.release-e2e-owner")"
  if [[ -z "${DEV_ANYWHERE_E2E_OWNER_TOKEN:-}" || "$owner_token" != "$DEV_ANYWHERE_E2E_OWNER_TOKEN" ]]; then
    echo "ERROR: refusing to remove an ephemeral profile with a different owner: $EPHEMERAL_PROFILE_DIR" >&2
    return 1
  fi
  profile_root_real="$(realpath "$HOME/.dev-anywhere/profiles")"
  profile_dir_real="$(realpath "$EPHEMERAL_PROFILE_DIR")"
  if [[ "$(dirname "$profile_dir_real")" == "$profile_root_real" && "$(basename "$profile_dir_real")" == "$DEV_PROFILE" && "$DEV_PROFILE" == release-e2e.* ]]; then
    rm -rf -- "$profile_dir_real"
    return
  fi
  echo "ERROR: refusing to remove unexpected ephemeral profile path: $EPHEMERAL_PROFILE_DIR" >&2
  return 1
}

recover_on_failure() {
  local code=$?
  trap - EXIT
  if [[ -n "$EPHEMERAL_PROFILE_DIR" ]]; then
    echo ""
    echo "=== Cleaning isolated release runtime ==="
    local cleanup_code=0
    cleanup_ephemeral_profile || cleanup_code=$?
    if [[ "$code" == "0" && "$cleanup_code" != "0" ]]; then
      code="$cleanup_code"
    fi
  elif [ "$code" -ne 0 ]; then
    echo ""
    echo "=== Chaos failed; restoring dev services ===" >&2
    restart_dev_services || true
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
  # CI must keep the child owned by the job shell. GitHub runners include
  # screen, but their detached sessions can disappear before launching Relay.
  if [[ -z "${CI:-}" ]] && command -v screen >/dev/null 2>&1; then
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

relay_http_ok() {
  curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$RELAY_PORT/api/status" >/dev/null
}

web_http_ok() {
  curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$WEB_PORT/" >/dev/null
}

relay_http_down() {
  ! relay_http_ok
}

web_http_down() {
  ! web_http_ok
}

run_real_ui_smoke() {
  local label="$1"
  echo "+ UI smoke: $label"
  WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh e2e/pc/chaos/integration/real-chaos.spec.ts
}

run_relay_down_ui_smoke() {
  echo "+ UI smoke: relay down state"
  DEV_ANYWHERE_EXPECT_RELAY_DOWN=1 WEB_BASE_URL="$WEB_BASE_URL" \
    bash scripts/test/pc.sh e2e/pc/chaos/integration/real-chaos.spec.ts
}

run_render_chaos_smoke() {
  echo "+ UI smoke: PTY render-time stale snapshot and duplicate frame handling"
  WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/pty-render-chaos.spec.ts
}

run_protocol_chaos_smoke() {
  echo "+ UI smoke: requestId snapshot and approval recovery chaos"
  WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/protocol-chaos.spec.ts
}

run_websocket_reconnect_chaos_smoke() {
  echo "+ UI smoke: client WebSocket reconnect state recovery"
  WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/websocket-chaos.spec.ts
}

run_real_provider_approval_smoke() {
  echo "+ UI smoke: real Claude/Codex hosted PTY approval"
  DEV_ANYWHERE_REAL_PROVIDER_CWD="$HOSTED_PTY_CHAOS_CWD" \
    WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/real-provider-approval.spec.ts
}

run_hosted_pty_exit_chaos_smoke() {
  local provider="$1"
  echo "+ UI smoke: hosted $provider PTY provider exit while Web is attached"
  DEV_ANYWHERE_HOSTED_PTY_CHAOS=1 \
    DEV_ANYWHERE_HOSTED_PTY_CHAOS_CWD="$HOSTED_PTY_CHAOS_CWD" \
    DEV_ANYWHERE_HOSTED_PTY_CHAOS_PROVIDER="$provider" \
    WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/integration/hosted-pty-chaos.spec.ts
}

run_local_runtime_pty_chaos_smoke() {
  local provider="$1"
  echo "+ UI smoke: local runtime $provider PTY reconnect and detach"
  DEV_ANYWHERE_LOCAL_PTY_CHAOS=1 \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_CWD="$LOCAL_PTY_CHAOS_CWD" \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_BIN="$LOCAL_PTY_CHAOS_BIN" \
    DEV_ANYWHERE_LOCAL_PTY_CHAOS_PROVIDER="$provider" \
    WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/integration/real-local-pty-chaos.spec.ts
}

run_json_worker_chaos_smoke() {
  echo "+ UI smoke: real Claude JSON worker approval and relay restart"
  DEV_ANYWHERE_JSON_WORKER_CHAOS=1 \
    DEV_ANYWHERE_JSON_WORKER_CHAOS_CWD="$JSON_WORKER_CHAOS_CWD" \
    WEB_BASE_URL="$WEB_BASE_URL" bash scripts/test/pc.sh \
    e2e/pc/chaos/integration/real-json-worker-chaos.spec.ts
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
  for _ in $(seq 1 20); do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && return
    sleep 0.1
  done
  echo "ERROR: $label listener on :$port did not stop (PID: $(echo "$pids" | tr '\n' ' '))" >&2
  return 1
}

service_status() {
  INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- --profile "$DEV_PROFILE" serve status 2>&1
}

mark_service_log() {
  local service_log="$PROXY_LOG_DIR/service.log"
  if [ -f "$service_log" ]; then
    SERVICE_LOG_CURSOR="$(wc -l <"$service_log" | tr -d ' ')"
  else
    SERVICE_LOG_CURSOR=0
  fi
}

service_log_since_marker() {
  local service_log="$PROXY_LOG_DIR/service.log"
  [ -f "$service_log" ] || return 1
  tail -n +"$((SERVICE_LOG_CURSOR + 1))" "$service_log"
}

service_pid() {
  service_status | sed -n 's/.*Service: running (PID \([0-9][0-9]*\)).*/\1/p' | head -n 1
}

proxy_relay_connected() {
  service_status | grep "Relay:   connected" >/dev/null
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
  service_status | grep "Relay:   disconnected" >/dev/null
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
  service_status | grep "Service: running" >/dev/null
}

started_proxy_process_alive() {
  [ -n "$STARTED_PROXY_PID" ] && kill -0 "$STARTED_PROXY_PID" 2>/dev/null
}

service_log_has_service_started() {
  service_log_since_marker | grep '"msg":"Service started"' >/dev/null
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
    output="$(INIT_CWD="$ROOT" proxy_serve_action start 2>&1)"
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
  start_detached "$ROOT/apps/relay" "$relay_log" env -u RELAY_PROXY_TOKEN -u RELAY_CLIENT_TOKEN -u ALLOWED_ORIGINS PORT="$RELAY_PORT" \
    DEV_ANYWHERE_RELAY_CHAOS="$chaos" \
    DEV_ANYWHERE_RELAY_CHAOS_TYPES="$RELAY_CHAOS_TYPES" \
    DEV_ANYWHERE_RELAY_CHAOS_DELAY_MS="$RELAY_CHAOS_DELAY_MS" \
    DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE="$RELAY_CHAOS_DUPLICATE" \
    DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE_DELAY_MS="$RELAY_CHAOS_DUPLICATE_DELAY_MS" \
    DEV_ANYWHERE_RELAY_CHAOS_REORDER="$RELAY_CHAOS_REORDER" \
    DEV_ANYWHERE_RELAY_CHAOS_REORDER_DELAY_MS="$RELAY_CHAOS_REORDER_DELAY_MS" \
    "$ROOT/node_modules/.bin/tsx" src/index.ts
  wait_until "relay HTTP status responds" 10 relay_http_ok
}

start_web_only() {
  local web_log
  web_log="$(prepare_run_log "$LOG_DIR/web-dev.log")"
  start_detached "$ROOT/apps/web" "$web_log" env DEV_ANYWHERE_WEB_RELAY_TARGET="http://127.0.0.1:$RELAY_PORT" "$ROOT/apps/web/node_modules/.bin/vite" --host 0.0.0.0 --port "$WEB_PORT" --strictPort
  wait_until "web HTTP responds" 10 web_http_ok
}

section "Baseline restart"
run restart_dev_services
run check_dev_health

section "Chaos 1: relay process crash and reconnect"
mark_service_log
kill_port "$RELAY_PORT" "relay"
wait_until "relay HTTP status is down" 10 relay_http_down
run_relay_down_ui_smoke
wait_until "proxy observes relay disconnected" 30 proxy_relay_disconnect_observed
start_relay_only
wait_until "proxy reconnects to restarted relay" 30 proxy_relay_connected_observed
run check_dev_health
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
run check_dev_health
run_real_ui_smoke "after proxy serve restart"

section "Chaos 3: web dev server crash and restart"
kill_port "$WEB_PORT" "web"
wait_until "web HTTP is down" 10 web_http_down
start_web_only
run check_dev_health
run_real_ui_smoke "after web restart"

section "Chaos 4: relay duplicate/reorder/delay with real UI"
kill_port "$RELAY_PORT" "relay"
wait_until "relay HTTP status is down" 10 relay_http_down
mark_service_log
start_relay_only 1
wait_until "proxy reconnects to chaos relay" 30 proxy_relay_connected_observed
run_real_ui_smoke "under relay duplicate/reorder/delay"
run check_dev_health

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
CLAUDE_BIN="$HOSTED_PTY_CHAOS_BIN" INIT_CWD="$ROOT" run proxy_serve_action restart
wait_until "proxy serve is running with hosted PTY chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after hosted PTY chaos provider swap" 30 proxy_relay_connected_observed
run_hosted_pty_exit_chaos_smoke claude
run check_dev_health

section "Chaos 10: hosted Codex PTY provider exit while Web is attached"
mark_service_log
CODEX_BIN="$HOSTED_PTY_CHAOS_BIN" INIT_CWD="$ROOT" run proxy_serve_action restart
wait_until "proxy serve is running with hosted Codex PTY chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after hosted Codex PTY chaos provider swap" 30 proxy_relay_connected_observed
run_hosted_pty_exit_chaos_smoke codex
run check_dev_health

section "Chaos 11: local runtime Claude/Codex PTY across serve restart"
create_local_pty_chaos_provider
run_local_runtime_pty_chaos_smoke claude
run_local_runtime_pty_chaos_smoke codex
run check_dev_health

section "Chaos 12: real Claude JSON worker approval across relay restart"
create_json_worker_chaos_provider
mark_service_log
CLAUDE_BIN="$JSON_WORKER_CHAOS_BIN" INIT_CWD="$ROOT" run proxy_serve_action restart
wait_until "proxy serve is running with JSON worker chaos provider" 15 proxy_service_running_observed
wait_until "proxy serve reconnects to relay after JSON worker provider swap" 30 proxy_relay_connected_observed
run_json_worker_chaos_smoke
run check_dev_health

if [[ -z "$EPHEMERAL_PROFILE_DIR" ]]; then
  section "Restore normal dev services"
  run restart_dev_services
  run check_dev_health
fi

section "Chaos completed"
ok "real local relay/web/proxy chaos scenarios passed"
