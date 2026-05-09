#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT}/artifacts/mobile-smoke"
WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"
RUN_REAL=1
CREATE_REAL_SESSIONS=0
RUN_SIMULATOR=0
DEVICE_NAME="${DEV_ANYWHERE_IOS_SIMULATOR:-iPhone 15}"

source "$ROOT/scripts/lib/smoke-common.sh"

for arg in "$@"; do
  case "$arg" in
    --contract-only) RUN_REAL=0 ;;
    --full) CREATE_REAL_SESSIONS=1 ;;
    --simulator) RUN_SIMULATOR=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: bash scripts/mobile-smoke.sh [--contract-only] [--full] [--simulator]" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$ARTIFACT_DIR"
cd "$ROOT"

smoke_use_stable_node
smoke_require_local_base_url "$WEB_BASE_URL" "mobile smoke"
trap smoke_cleanup EXIT

smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$WEB_BASE_URL"

WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e:mobile:contract

if [[ "$RUN_REAL" == "1" ]]; then
  smoke_require_local_real_chain "$ROOT"
  DEV_ANYWHERE_REAL_LOCAL_SMOKE=1 \
    DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE="$CREATE_REAL_SESSIONS" \
    WEB_BASE_URL="$WEB_BASE_URL" \
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
xcrun simctl openurl "$UDID" "$WEB_BASE_URL"
sleep 5
xcrun simctl io "$UDID" screenshot "$ARTIFACT_DIR/ios-safari-portrait.png"
rotate_simulator_menu_item "Rotate Left"
sleep 2
xcrun simctl io "$UDID" screenshot "$ARTIFACT_DIR/ios-safari-landscape.png"
rotate_simulator_menu_item "Rotate Right"

echo "mobile smoke artifacts: $ARTIFACT_DIR"
