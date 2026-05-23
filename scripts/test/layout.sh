#!/usr/bin/env bash
# Tier 2 - Playwright viewport, 布局/响应式断点回归. e2e/layout/ 下全 spec.
# 触屏 / IME / 字体 / canvas 渲染由 L4 (test-mobile.sh, Android emu) 负责.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/smoke-common.sh"

ARTIFACT_DIR="${ROOT}/artifacts/test-layout"
BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"
PLAYWRIGHT_FLAKY_ARGS=()
if [[ "${PLAYWRIGHT_FAIL_ON_FLAKY_TESTS:-1}" != "0" ]]; then
  PLAYWRIGHT_FLAKY_ARGS+=(--fail-on-flaky-tests)
fi

mkdir -p "$ARTIFACT_DIR"
smoke_use_stable_node
trap smoke_cleanup EXIT
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"

cd "$ROOT/apps/web"
WEB_BASE_URL="$BASE_URL" exec ./node_modules/.bin/playwright test \
  --project=layout-mobile-small \
  --project=layout-mobile \
  --project=layout-mobile-landscape \
  --project=layout-desktop \
  "${PLAYWRIGHT_FLAKY_ARGS[@]}" \
  "$@"
