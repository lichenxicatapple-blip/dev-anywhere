#!/usr/bin/env bash
# Tier 3 - Playwright 真桌面 Chromium, clipboard/WebGL/键盘等真浏览器能力.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/smoke-common.sh"

ARTIFACT_DIR="${ROOT}/artifacts/test-pc"
BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"

mkdir -p "$ARTIFACT_DIR"
smoke_use_stable_node
trap smoke_cleanup EXIT
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"

DEFAULT_SPECS=(
  e2e/shell.spec.ts
  e2e/proxy-switcher.spec.ts
  e2e/session-list.spec.ts
  e2e/input-bar.spec.ts
  e2e/functional-walkthrough.spec.ts
  e2e/chat-chrome.spec.ts
)

cd "$ROOT/apps/web"
if [[ "$#" -gt 0 ]]; then
  WEB_BASE_URL="$BASE_URL" exec ./node_modules/.bin/playwright test --project=device-pc "$@"
else
  WEB_BASE_URL="$BASE_URL" exec ./node_modules/.bin/playwright test --project=device-pc "${DEFAULT_SPECS[@]}"
fi
