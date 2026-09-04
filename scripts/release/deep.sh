#!/usr/bin/env bash
# Slow, environment-dependent release validation. Process Chaos and Android Chrome
# are mandatory in release.sh; the real file transport chain remains opt-in.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/stage-timing.sh"

ARTIFACT_DIR="${RELEASE_DEEP_ARTIFACT_DIR:-$ROOT/artifacts/release-deep}"
TIMING_REPORT="$ARTIFACT_DIR/timing.tsv"
# Release validation favors deterministic native IME/visualViewport behavior over
# emulator sharding. Developers can still opt into a larger pool explicitly.
RELEASE_MOBILE_EMULATORS="${RELEASE_MOBILE_EMULATORS:-1}"
RELEASE_MOBILE_KEEP_EMULATORS="${RELEASE_MOBILE_KEEP_EMULATORS:-0}"
RELEASE_MOBILE_GPU_MODE="${RELEASE_MOBILE_GPU_MODE:-swiftshader_indirect}"
RELEASE_MOBILE_BASE_PORT="${DEV_ANYWHERE_MOBILE_BASE_PORT:-5570}"
RELEASE_MOBILE_SERIAL="emulator-${RELEASE_MOBILE_BASE_PORT}"
RELEASE_DEEP_SCOPE="${RELEASE_DEEP_SCOPE:-all}"
ISOLATED_PROFILE_DIR=""
ISOLATED_PROFILE=""
ISOLATED_RELAY_PORT=""
ISOLATED_WEB_PORT=""
ISOLATED_HOOK_PORT=""
ISOLATED_LOG_DIR=""
ISOLATED_WORKDIR=""
ISOLATED_OWNER_TOKEN=""
MOBILE_STARTED=0

case "$RELEASE_DEEP_SCOPE" in
  all | real | chaos | mobile) ;;
  *)
    echo "ERROR: RELEASE_DEEP_SCOPE must be all, real, chaos, or mobile (got: $RELEASE_DEEP_SCOPE)" >&2
    exit 2
    ;;
esac

cleanup_mobile_emulators() {
  if [[ "$MOBILE_STARTED" != "1" || "$RELEASE_MOBILE_KEEP_EMULATORS" == "1" ]]; then
    return 0
  fi
  DEV_ANYWHERE_MOBILE_BASE_PORT="$RELEASE_MOBILE_BASE_PORT" \
    bash scripts/test/mobile-emulators.sh stop "$RELEASE_MOBILE_EMULATORS" >/dev/null 2>&1 || true
  MOBILE_STARTED=0
}

allocate_isolated_ports() {
  node <<'NODE'
const net = require("node:net");
const servers = [];
const ports = [];

function allocate() {
  if (servers.length === 3) {
    process.stdout.write(`${ports.join(" ")}\n`);
    let pending = servers.length;
    for (const server of servers) server.close(() => --pending === 0 && process.exit(0));
    return;
  }

  const server = net.createServer();
  server.once("error", (error) => {
    process.stderr.write(`failed to allocate isolated release port: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(0, "127.0.0.1", () => {
    servers.push(server);
    ports.push(server.address().port);
    allocate();
  });
}

allocate();
NODE
}

setup_isolated_runtime() {
  local profile_root ports
  profile_root="$HOME/.dev-anywhere/profiles"
  mkdir -p "$profile_root"
  ISOLATED_PROFILE_DIR="$(mktemp -d "$profile_root/release-e2e.XXXXXX")"
  ISOLATED_PROFILE="$(basename "$ISOLATED_PROFILE_DIR")"
  ISOLATED_OWNER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  printf '%s\n' "$ISOLATED_OWNER_TOKEN" >"$ISOLATED_PROFILE_DIR/.release-e2e-owner"

  ports="$(allocate_isolated_ports)"
  read -r ISOLATED_RELAY_PORT ISOLATED_WEB_PORT ISOLATED_HOOK_PORT <<<"$ports"
  for port in "$ISOLATED_RELAY_PORT" "$ISOLATED_WEB_PORT" "$ISOLATED_HOOK_PORT"; do
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
      echo "ERROR: invalid isolated runtime port: $port" >&2
      return 1
    fi
  done

  ISOLATED_LOG_DIR="$ARTIFACT_DIR/runtime-$ISOLATED_PROFILE"
  ISOLATED_WORKDIR="$ISOLATED_PROFILE_DIR/work"
  mkdir -p "$ISOLATED_LOG_DIR" "$ISOLATED_WORKDIR"

  # The profile name owns socket/PID/state under ~/.dev-anywhere/profiles. RELAY_URL
  # intentionally avoids adding a temporary relay/profile entry to the user's config.
  export RELAY_URL="ws://127.0.0.1:$ISOLATED_RELAY_PORT"
  export DEV_ANYWHERE_HOOK_PORT="$ISOLATED_HOOK_PORT"
  export DEV_ANYWHERE_E2E_PROFILE="$ISOLATED_PROFILE"
  export DEV_ANYWHERE_E2E_RELAY=""
  export DEV_ANYWHERE_E2E_RELAY_PORT="$ISOLATED_RELAY_PORT"
  export DEV_ANYWHERE_E2E_HOOK_PORT="$ISOLATED_HOOK_PORT"
  export DEV_ANYWHERE_E2E_RELAY_URL="$RELAY_URL"
  export DEV_ANYWHERE_E2E_LOG_DIR="$ISOLATED_LOG_DIR"
  export DEV_ANYWHERE_E2E_OWNER_TOKEN="$ISOLATED_OWNER_TOKEN"
  export DATA_DIR="$ISOLATED_PROFILE_DIR/relay-data"

  echo "Isolated release runtime:"
  echo "  profile: $ISOLATED_PROFILE"
  echo "  relay:   $RELAY_URL"
  echo "  web:     http://127.0.0.1:$ISOLATED_WEB_PORT"
  echo "  hook:    127.0.0.1:$ISOLATED_HOOK_PORT"
}

stop_isolated_port() {
  local port="$1"
  local pids
  [[ -n "$port" ]] || return 0
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && return
    sleep 0.1
  done
  kill -9 $pids 2>/dev/null || true
  sleep 0.1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "ERROR: isolated listener on :$port did not stop (PID: $(echo "$pids" | tr '\n' ' '))" >&2
    return 1
  fi
}

clear_isolated_runtime_state() {
  ISOLATED_PROFILE_DIR=""
  ISOLATED_PROFILE=""
  ISOLATED_RELAY_PORT=""
  ISOLATED_WEB_PORT=""
  ISOLATED_HOOK_PORT=""
  ISOLATED_LOG_DIR=""
  ISOLATED_WORKDIR=""
  ISOLATED_OWNER_TOKEN=""
  unset RELAY_URL DEV_ANYWHERE_HOOK_PORT DEV_ANYWHERE_E2E_PROFILE DEV_ANYWHERE_E2E_RELAY
  unset DEV_ANYWHERE_E2E_RELAY_PORT DEV_ANYWHERE_E2E_HOOK_PORT DEV_ANYWHERE_E2E_RELAY_URL
  unset DEV_ANYWHERE_E2E_LOG_DIR DEV_ANYWHERE_E2E_OWNER_TOKEN DATA_DIR
}

isolated_pty_screens() {
  local screen_session screen_name
  [[ -n "$ISOLATED_PROFILE" ]] || return 0
  if ! command -v screen >/dev/null 2>&1; then
    return 0
  fi
  while IFS= read -r screen_session; do
    screen_name="${screen_session#*.}"
    case "$screen_name" in
      "dev-anywhere-local-pty-${ISOLATED_PROFILE}-"*) printf '%s\n' "$screen_session" ;;
    esac
  done < <(screen -ls 2>/dev/null | awk '$1 ~ /^[0-9]+\./ { print $1 }' || true)
}

stop_isolated_pty_screens() {
  local screen_session remaining=""
  while IFS= read -r screen_session; do
    [[ -n "$screen_session" ]] || continue
    screen -S "$screen_session" -X quit >/dev/null 2>&1 || true
  done < <(isolated_pty_screens)
  for _ in $(seq 1 20); do
    remaining="$(isolated_pty_screens)"
    [[ -z "$remaining" ]] && return
    sleep 0.1
  done
  echo "ERROR: isolated local PTY screen did not stop: $remaining" >&2
  return 1
}

cleanup_isolated_runtime() {
  [[ -n "$ISOLATED_PROFILE_DIR" ]] || return 0
  local stop_output stop_ok=1 pid="" profile_root_real profile_dir_real owner_token

  # chaos.sh owns the inner run and removes the profile only after it has stopped
  # its daemon, screens, and listeners. Do not probe or kill recycled dynamic ports
  # after that handoff has completed.
  if [[ ! -e "$ISOLATED_PROFILE_DIR" ]]; then
    clear_isolated_runtime_state
    return
  fi

  if [[ -L "$ISOLATED_PROFILE_DIR/.release-e2e-owner" || ! -f "$ISOLATED_PROFILE_DIR/.release-e2e-owner" ]]; then
    echo "ERROR: isolated profile ownership marker is missing or unsafe: $ISOLATED_PROFILE_DIR" >&2
    return 1
  fi
  owner_token="$(tr -d '\r\n' <"$ISOLATED_PROFILE_DIR/.release-e2e-owner")"
  if [[ -z "$ISOLATED_OWNER_TOKEN" || "$owner_token" != "$ISOLATED_OWNER_TOKEN" ]]; then
    echo "ERROR: isolated profile ownership marker does not match: $ISOLATED_PROFILE_DIR" >&2
    return 1
  fi

  if ! stop_isolated_pty_screens; then
    stop_ok=0
  fi
  if [[ -d "$ISOLATED_PROFILE_DIR" ]]; then
    if ! stop_output="$(INIT_CWD="$ROOT" pnpm --filter @dev-anywhere/proxy run dev -- \
      --profile "$ISOLATED_PROFILE" serve stop 2>&1)"; then
      stop_ok=0
      echo "ERROR: failed to stop isolated Proxy profile $ISOLATED_PROFILE:" >&2
      printf '%s\n' "$stop_output" >&2
    fi
    if [[ -f "$ISOLATED_PROFILE_DIR/run/dev-anywhere.pid" ]]; then
      pid="$(tr -d '[:space:]' <"$ISOLATED_PROFILE_DIR/run/dev-anywhere.pid")"
      if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
        stop_ok=0
        echo "ERROR: isolated Proxy PID $pid is still alive; retaining $ISOLATED_PROFILE_DIR" >&2
      fi
    fi
  fi
  stop_isolated_port "$ISOLATED_WEB_PORT" || stop_ok=0
  stop_isolated_port "$ISOLATED_RELAY_PORT" || stop_ok=0
  stop_isolated_port "$ISOLATED_HOOK_PORT" || stop_ok=0

  if [[ -d "$ISOLATED_PROFILE_DIR/logs" ]]; then
    mkdir -p "$ISOLATED_LOG_DIR/profile-logs"
    if ! cp -R "$ISOLATED_PROFILE_DIR/logs/." "$ISOLATED_LOG_DIR/profile-logs/"; then
      stop_ok=0
      echo "ERROR: failed to preserve isolated Proxy logs from $ISOLATED_PROFILE_DIR" >&2
    fi
  fi

  if [[ "$stop_ok" != "1" ]]; then
    return 1
  fi
  if [[ ! -e "$ISOLATED_PROFILE_DIR" ]]; then
    : # chaos.sh already completed the same guarded cleanup
  elif [[ -L "$ISOLATED_PROFILE_DIR" ]]; then
    echo "ERROR: refusing to remove symlinked isolated profile: $ISOLATED_PROFILE_DIR" >&2
    return 1
  else
    profile_root_real="$(realpath "$HOME/.dev-anywhere/profiles")"
    profile_dir_real="$(realpath "$ISOLATED_PROFILE_DIR")"
    if [[ "$(dirname "$profile_dir_real")" != "$profile_root_real" || "$(basename "$profile_dir_real")" != "$ISOLATED_PROFILE" || "$ISOLATED_PROFILE" != release-e2e.* ]]; then
      echo "ERROR: refusing to remove unexpected isolated profile path: $ISOLATED_PROFILE_DIR" >&2
      return 1
    fi
    rm -rf -- "$profile_dir_real"
  fi

  clear_isolated_runtime_state
}

cleanup_release_deep() {
  local code=$?
  local cleanup_code=0
  trap - EXIT
  cleanup_isolated_runtime || cleanup_code=$?
  cleanup_mobile_emulators || cleanup_code=$?
  if [[ "$code" != "0" ]]; then
    exit "$code"
  fi
  exit "$cleanup_code"
}

mkdir -p "$ARTIFACT_DIR"
stage_timing_init "$TIMING_REPORT"
trap cleanup_release_deep EXIT

if [[ "${RELEASE_DEEP_SKIP_FAST:-0}" != "1" ]]; then
  run_timed_stage "fast-release-gate" pnpm release:smoke
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "real" || "$RELEASE_DEEP_SCOPE" == "chaos" ]]; then
  setup_isolated_runtime
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "real" ]]; then
  run_timed_stage "local-chain-start" pnpm dev:restart -- \
    --profile "$ISOLATED_PROFILE" \
    --relay-port "$ISOLATED_RELAY_PORT" \
    --web-port "$ISOLATED_WEB_PORT" \
    --log-dir "$ISOLATED_LOG_DIR"
  run_timed_stage "real-file-chain" env \
    DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 \
    WEB_BASE_URL="http://127.0.0.1:$ISOLATED_WEB_PORT" \
    bash scripts/test/pc.sh e2e/pc/real-clipboard-image.spec.ts
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "chaos" ]]; then
  run_timed_stage "process-chaos" pnpm dev:chaos -- \
    --profile "$ISOLATED_PROFILE" \
    --relay-port "$ISOLATED_RELAY_PORT" \
    --web-port "$ISOLATED_WEB_PORT" \
    --base-url "http://127.0.0.1:$ISOLATED_WEB_PORT" \
    --workdir "$ISOLATED_WORKDIR" \
    --log-dir "$ISOLATED_LOG_DIR" \
    --ephemeral-profile-dir "$ISOLATED_PROFILE_DIR"
fi
if [[ "$RELEASE_DEEP_SCOPE" != "mobile" ]]; then
  cleanup_isolated_runtime
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "mobile" ]]; then
  MOBILE_STARTED=1
  run_timed_stage "mobile-emulator-start" env \
    DEV_ANYWHERE_MOBILE_BASE_PORT="$RELEASE_MOBILE_BASE_PORT" \
    DEV_ANYWHERE_MOBILE_GPU_MODE="$RELEASE_MOBILE_GPU_MODE" \
    bash scripts/test/mobile-emulators.sh start "$RELEASE_MOBILE_EMULATORS"
  run_timed_stage "android-e2e" env \
    ANDROID_SERIAL="$RELEASE_MOBILE_SERIAL" \
    TEST_MOBILE_REQUIRE_EMULATOR=1 \
    TEST_MOBILE_RESET_FAIL_FAST=1 \
    pnpm test:mobile
fi

print_stage_timing_summary
echo "deep release validation passed"
