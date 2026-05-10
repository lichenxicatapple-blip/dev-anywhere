#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT}/artifacts/mobile-smoke"
BASE_URL="http://127.0.0.1:5173"
RELAY_PORT="3100"
# 默认空：未显式指定时由 resolve-dev-profile.mjs 按 ws://localhost:<relay-port> 解析。
PROFILE=""
RELAY=""
RUN_REAL=1
CREATE_REAL_SESSIONS=0
RUN_SIMULATOR=0
DEVICE_NAME="iPhone 15"

source "$ROOT/scripts/lib/smoke-common.sh"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --contract-only)
      RUN_REAL=0
      shift
      ;;
    --full)
      CREATE_REAL_SESSIONS=1
      shift
      ;;
    --simulator)
      RUN_SIMULATOR=1
      shift
      ;;
    --base-url)
      BASE_URL="${2:-}"
      [[ -n "$BASE_URL" ]] || { echo "ERROR: missing value for --base-url" >&2; exit 2; }
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#--base-url=}"
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
    --profile)
      PROFILE="${2:-}"
      [[ -n "$PROFILE" ]] || { echo "ERROR: missing value for --profile" >&2; exit 2; }
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    --relay)
      RELAY="${2:-}"
      [[ -n "$RELAY" ]] || { echo "ERROR: missing value for --relay" >&2; exit 2; }
      shift 2
      ;;
    --relay=*)
      RELAY="${1#--relay=}"
      shift
      ;;
    --device)
      DEVICE_NAME="${2:-}"
      [[ -n "$DEVICE_NAME" ]] || { echo "ERROR: missing value for --device" >&2; exit 2; }
      shift 2
      ;;
    --device=*)
      DEVICE_NAME="${1#--device=}"
      shift
      ;;
    -h | --help)
      echo "usage: bash scripts/mobile-smoke.sh [--base-url <url>] [--relay-port <port>] [--profile <name>] [--relay <name>] [--contract-only] [--full] [--simulator] [--device <name>]" >&2
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: bash scripts/mobile-smoke.sh [--base-url <url>] [--relay-port <port>] [--profile <name>] [--relay <name>] [--contract-only] [--full] [--simulator] [--device <name>]" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$ARTIFACT_DIR"
cd "$ROOT"

if [[ -z "$PROFILE" || -z "$RELAY" ]]; then
  resolved="$(node "$ROOT/scripts/lib/resolve-dev-profile.mjs" --relay-url "ws://localhost:$RELAY_PORT")" || exit $?
  eval "$resolved"
  : "${PROFILE:=$RESOLVED_PROFILE}"
  : "${RELAY:=$RESOLVED_RELAY}"
  unset RESOLVED_PROFILE RESOLVED_RELAY
fi

smoke_use_stable_node
smoke_require_local_base_url "$BASE_URL" "mobile smoke"
trap smoke_cleanup EXIT

smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"

WEB_BASE_URL="$BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e:mobile:contract

if [[ "$RUN_REAL" == "1" ]]; then
  smoke_require_local_real_chain "$ROOT" "$RELAY_PORT" "$PROFILE" "$RELAY"
  DEV_ANYWHERE_REAL_LOCAL_SMOKE=1 \
    DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE="$CREATE_REAL_SESSIONS" \
    WEB_BASE_URL="$BASE_URL" \
    pnpm --filter @dev-anywhere/web run test:e2e:mobile:real
fi

if [[ "$RUN_SIMULATOR" != "1" ]]; then
  exit 0
fi

rotate_simulator_menu_item() {
  local item="$1"
  local click_item
  click_item="tell process \"Simulator\" to click menu item \"${item}\""
  click_item="${click_item} of menu \"Device\" of menu bar 1"
  osascript \
    -e 'tell application "Simulator" to activate' \
    -e "tell application \"System Events\" to ${click_item}" \
    >/dev/null
}

UDID="$(
  {
    xcrun simctl list devices available | grep -F "    ${DEVICE_NAME} (" ||
      xcrun simctl list devices available | grep -F "$DEVICE_NAME" ||
      true
  } |
    sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p' |
    head -n 1
)"

if [[ -z "$UDID" ]]; then
  echo "No available simulator found for ${DEVICE_NAME}" >&2
  exit 1
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "$UDID" >/dev/null 2>&1 || true
osascript -e 'tell application "Simulator" to activate' >/dev/null
sleep 1
xcrun simctl openurl "$UDID" "$BASE_URL"
sleep 5
xcrun simctl io "$UDID" screenshot "$ARTIFACT_DIR/ios-safari-portrait.png"
rotate_simulator_menu_item "Rotate Left"
sleep 2
xcrun simctl io "$UDID" screenshot "$ARTIFACT_DIR/ios-safari-landscape.png"
rotate_simulator_menu_item "Rotate Right"

echo "mobile smoke artifacts: $ARTIFACT_DIR"
