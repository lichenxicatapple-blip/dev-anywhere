#!/usr/bin/env bash
# Tier 3 - Playwright 真桌面 Chromium, e2e/pc/ 下全 spec.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/smoke-common.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

ARTIFACT_DIR="${ROOT}/artifacts/test-pc"
BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"
PLAYWRIGHT_FLAKY_ARGS=()
if [[ "${PLAYWRIGHT_FAIL_ON_FLAKY_TESTS:-1}" != "0" ]]; then
  PLAYWRIGHT_FLAKY_ARGS+=(--fail-on-flaky-tests)
fi
unset NO_COLOR FORCE_COLOR
PROJECT="${PLAYWRIGHT_PC_PROJECT:-device-pc}"

pc_arg_is_opt_in_spec() {
  case "$1" in
    e2e/pc/real-*.spec.ts | pc/real-*.spec.ts | real-*.spec.ts | */e2e/pc/real-*.spec.ts | */pc/real-*.spec.ts)
      return 0
      ;;
    e2e/pc/chaos/integration/*.spec.ts | pc/chaos/integration/*.spec.ts | chaos/integration/*.spec.ts | */e2e/pc/chaos/integration/*.spec.ts | */pc/chaos/integration/*.spec.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ -z "${PLAYWRIGHT_PC_PROJECT:-}" ]]; then
  for arg in "$@"; do
    [[ "$arg" == -* ]] && continue
    if pc_arg_is_opt_in_spec "$arg"; then
      PROJECT="device-pc-real"
      break
    fi
  done
fi

mkdir -p "$ARTIFACT_DIR"
smoke_use_stable_node
trap smoke_cleanup EXIT
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"

cd "$ROOT/apps/web"
if ((${#PLAYWRIGHT_FLAKY_ARGS[@]})); then
  WEB_BASE_URL="$BASE_URL" exec ./node_modules/.bin/playwright test --project="$PROJECT" "${PLAYWRIGHT_FLAKY_ARGS[@]}" "$@"
else
  WEB_BASE_URL="$BASE_URL" exec ./node_modules/.bin/playwright test --project="$PROJECT" "$@"
fi
