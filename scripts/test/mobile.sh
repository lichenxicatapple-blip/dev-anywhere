#!/usr/bin/env bash
# Tier 4 - 真 Android 模拟器 + Chrome CDP. 缺 emu 自动跳过 + 退 0 (PR 闸不卡).
# 强制要求 emu: 设 TEST_MOBILE_REQUIRE_EMULATOR=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/e2e-tiers.sh"
source "$ROOT/scripts/lib/smoke-common.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

REQUIRE="${TEST_MOBILE_REQUIRE_EMULATOR:-0}"

for arg in "$@"; do
  if [[ "$arg" == "--list" ]]; then
    smoke_use_stable_node
    cd "$ROOT/apps/web"
    exec pnpm exec playwright test --project=device-mobile-android "$@"
  fi
done

if ! e2e_mobile_emulator_ready; then
  if [[ "$REQUIRE" == "1" ]]; then
    echo "ERROR: TEST_MOBILE_REQUIRE_EMULATOR=1 but no Android device online via adb." >&2
    exit 2
  fi
  echo "[mobile] No Android emulator online — skipping (set TEST_MOBILE_REQUIRE_EMULATOR=1 to fail instead)."
  exit 0
fi

ARTIFACT_DIR="${TEST_MOBILE_ARTIFACT_DIR:-$ROOT/artifacts/test-mobile}"
if [[ "$ARTIFACT_DIR" != /* ]]; then
  ARTIFACT_DIR="$ROOT/$ARTIFACT_DIR"
fi
BASE_URL="http://127.0.0.1:${TIER_MOBILE_VITE_PORT}"
CDP_PORT="${TIER_MOBILE_CDP_PORT:-9222}"
CDP_READY_TIMEOUT_SECONDS="${TEST_MOBILE_CDP_READY_TIMEOUT_SECONDS:-60}"
CDP_READY_POLL_SECONDS="${TEST_MOBILE_CDP_READY_POLL_SECONDS:-0.25}"
RESET_FAIL_FAST="${TEST_MOBILE_RESET_FAIL_FAST:-0}"
TIMING_REPORT="$ARTIFACT_DIR/mobile-timing.tsv"
PLAYWRIGHT_FLAKY_ARGS=()
if [[ "${PLAYWRIGHT_FAIL_ON_FLAKY_TESTS:-1}" != "0" ]]; then
  PLAYWRIGHT_FLAKY_ARGS+=(--fail-on-flaky-tests)
fi
unset NO_COLOR FORCE_COLOR

mkdir -p "$ARTIFACT_DIR"
trap 'e2e_mobile_remove_forward_port "$CDP_PORT"; e2e_mobile_teardown_adb_reverse; smoke_cleanup' EXIT
smoke_use_stable_node
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"
e2e_mobile_setup_adb_reverse
e2e_mobile_prepare_soft_keyboard
adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null

echo "[mobile] vite=$BASE_URL relay=:${TIER_MOBILE_RELAY_PORT} cdp=:$CDP_PORT adb=${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | xargs)}"

cd "$ROOT/apps/web"

mobile_now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

mobile_format_ms() {
  awk -v ms="$1" 'BEGIN { printf "%.1fs", ms / 1000 }'
}

mobile_elapsed_ms() {
  local start_ms="$1"
  local now_ms
  now_ms="$(mobile_now_ms)"
  echo $((now_ms - start_ms))
}

mobile_cdp_ready() {
  curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1
}

mobile_cdp_has_page() {
  curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json" | python3 -c \
    "import json, sys; targets=json.load(sys.stdin); sys.exit(0 if any(t.get('type') == 'page' for t in targets) else 1)" \
    >/dev/null 2>&1
}

mobile_wait_for_cdp_page() {
  local start_ms timeout_ms elapsed_ms
  start_ms="$(mobile_now_ms)"
  timeout_ms=$((CDP_READY_TIMEOUT_SECONDS * 1000))

  while true; do
    e2e_mobile_accept_chrome_first_run >/dev/null 2>&1 || true
    if ! adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null 2>&1; then
      sleep "$CDP_READY_POLL_SECONDS"
      continue
    fi
    if mobile_cdp_ready && mobile_cdp_has_page; then
      return 0
    fi

    elapsed_ms="$(mobile_elapsed_ms "$start_ms")"
    if [[ "$elapsed_ms" -ge "$timeout_ms" ]]; then
      break
    fi
    sleep "$CDP_READY_POLL_SECONDS"
  done

  mobile_cdp_ready && mobile_cdp_has_page
}

mobile_close_stale_tabs() {
  # Keep the first page that matches BASE_URL when possible, because that is the
  # freshly launched target. Android Chrome may also restore old tabs after a
  # force-stop, and leaving those around makes CDP page selection flaky.
  local stale_ids
  stale_ids="$(curl --noproxy '*' -s -m 2 "http://localhost:$CDP_PORT/json" | BASE_URL="$BASE_URL" python3 -c \
    "import json, os, sys
targets = json.load(sys.stdin)
pages = [t for t in targets if t.get('type') == 'page' and t.get('id')]
base = os.environ.get('BASE_URL', '')
keep = None
for target in pages:
    if target.get('url', '').startswith(base):
        keep = target.get('id')
        break
if keep is None and pages:
    keep = pages[0].get('id')
print(' '.join(t.get('id') for t in pages if t.get('id') != keep))" 2>/dev/null || true)"

  for id in $stale_ids; do
    curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json/close/$id" >/dev/null || true
  done

  # Avoid a blind sleep. Most closes settle immediately, but poll briefly so the
  # next Playwright attach does not race stale tab removal.
  for _ in $(seq 1 20); do
    if curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json" | python3 -c \
      "import json, sys; targets=json.load(sys.stdin); pages=[t for t in targets if t.get('type') == 'page']; sys.exit(0 if len(pages) <= 1 else 1)" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
}

# Android Chrome over CDP 不支持 newContext 隔离 + page.close 不真删 tab + addInitScript
# 不能 unregister, 跨 spec file 共用同一 chrome 进程会 navigation race. 解决方案是
# 每个 spec file 都给它一个干净 chrome 进程: force-stop + 重启 + adb forward 重建 +
# playwright 单独跑该 spec. 同 spec file 内多 test 仍共享 page (worker scope).
reset_chrome() {
  if [[ "${ANDROID_SERIAL:-}" != emulator-* && "${TEST_MOBILE_ALLOW_REAL_DEVICE_RESET:-0}" != "1" ]]; then
    echo "ERROR: refusing to reset Chrome on real Android device ${ANDROID_SERIAL:-unknown}." >&2
    echo "Set TEST_MOBILE_ALLOW_REAL_DEVICE_RESET=1 only for a dedicated test device." >&2
    return 1
  fi
  # force-stop 后 chrome restore session 把 tab 全恢复, page.close 在 emu 上又不真删
  # tab, 跑多了累积几十个 tab 会让 page.goto / locator 操作 timeout. CDP /json/close
  # endpoint 是真能 close target 的, 拿它把多余 tab 关掉留 1 个干净的.
  adb shell am force-stop com.android.chrome >/dev/null 2>&1 || true
  e2e_mobile_setup_adb_reverse
  e2e_mobile_remove_forward_port "$CDP_PORT"
  adb shell am start -a android.intent.action.VIEW -d "$BASE_URL/" >/dev/null 2>&1
  e2e_mobile_accept_chrome_first_run >/dev/null 2>&1 || true
  if ! mobile_wait_for_cdp_page; then
    echo "ERROR: chrome 重启后 CDP ${CDP_READY_TIMEOUT_SECONDS}s 内仍无可用 page target" >&2
    return 1
  fi
  mobile_close_stale_tabs
}

if [[ "$#" -gt 0 ]]; then
  SPECS=("$@")
else
  # macOS 默认 bash 3.2 没 mapfile, 用 glob 展开
  SPECS=(e2e/mobile/*.spec.ts)
fi

EXIT_CODE=0
REPORT_SPEC=()
REPORT_STATUS=()
REPORT_RESET_MS=()
REPORT_TEST_MS=()
REPORT_TOTAL_MS=()

mobile_record_timing() {
  REPORT_SPEC+=("$1")
  REPORT_STATUS+=("$2")
  REPORT_RESET_MS+=("$3")
  REPORT_TEST_MS+=("$4")
  REPORT_TOTAL_MS+=("$5")
}

mobile_run_playwright_spec() {
  local spec="$1"
  if ((${#PLAYWRIGHT_FLAKY_ARGS[@]})); then
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://localhost:$CDP_PORT" \
      ./node_modules/.bin/playwright test --project=device-mobile-android --workers=1 "${PLAYWRIGHT_FLAKY_ARGS[@]}" "$spec"
  else
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://localhost:$CDP_PORT" \
      ./node_modules/.bin/playwright test --project=device-mobile-android --workers=1 "$spec"
  fi
}

mobile_print_timing_report() {
  local count i total_reset_ms total_test_ms total_ms top_n
  count="${#REPORT_SPEC[@]}"
  total_reset_ms=0
  total_test_ms=0
  total_ms=0
  top_n="${TEST_MOBILE_TIMING_TOP_N:-8}"

  printf 'spec\tstatus\treset_s\ttest_s\ttotal_s\n' >"$TIMING_REPORT"
  for ((i = 0; i < count; i++)); do
    total_reset_ms=$((total_reset_ms + REPORT_RESET_MS[i]))
    total_test_ms=$((total_test_ms + REPORT_TEST_MS[i]))
    total_ms=$((total_ms + REPORT_TOTAL_MS[i]))
    printf '%s\t%s\t%.3f\t%.3f\t%.3f\n' \
      "${REPORT_SPEC[i]}" \
      "${REPORT_STATUS[i]}" \
      "$(awk -v ms="${REPORT_RESET_MS[i]}" 'BEGIN { print ms / 1000 }')" \
      "$(awk -v ms="${REPORT_TEST_MS[i]}" 'BEGIN { print ms / 1000 }')" \
      "$(awk -v ms="${REPORT_TOTAL_MS[i]}" 'BEGIN { print ms / 1000 }')" \
      >>"$TIMING_REPORT"
  done

  echo ""
  echo "[mobile] timing report: $TIMING_REPORT"
  echo "[mobile] total reset=$(mobile_format_ms "$total_reset_ms") test=$(mobile_format_ms "$total_test_ms") wall=$(mobile_format_ms "$total_ms")"
  if [[ "$count" -gt 0 ]]; then
    echo "[mobile] slowest specs:"
    tail -n +2 "$TIMING_REPORT" | sort -t "$(printf '\t')" -k5,5nr | head -n "$top_n" | awk -F '\t' '{ printf "  %s total=%ss reset=%ss test=%ss status=%s\n", $1, $5, $3, $4, $2 }'
  fi
}

for spec in "${SPECS[@]}"; do
  echo ""
  echo "=== $spec ==="
  SPEC_START_MS="$(mobile_now_ms)"
  RESET_START_MS="$(mobile_now_ms)"
  if ! reset_chrome; then
    RESET_MS="$(mobile_elapsed_ms "$RESET_START_MS")"
    TOTAL_MS="$(mobile_elapsed_ms "$SPEC_START_MS")"
    echo "[mobile] $spec reset failed after $(mobile_format_ms "$RESET_MS")"
    mobile_record_timing "$spec" "reset-failed" "$RESET_MS" 0 "$TOTAL_MS"
    EXIT_CODE=1
    if [[ "$RESET_FAIL_FAST" == "1" ]]; then
      break
    fi
    continue
  fi
  RESET_MS="$(mobile_elapsed_ms "$RESET_START_MS")"
  # WEB_BASE_URL 给 helpers.ts 的 BASE_URL (selectFakeProxy / gotoWithFakeProxy 等),
  # mobile 跑独立 vite 在 5174 不是 host 5173, 不让 helpers 默认值 5173 把 emu 带去
  # connection refused。
  TEST_START_MS="$(mobile_now_ms)"
  if mobile_run_playwright_spec "$spec"; then
    SPEC_STATUS="passed"
  else
    SPEC_RC="$?"
    SPEC_STATUS="failed($SPEC_RC)"
    EXIT_CODE="$SPEC_RC"
  fi
  TEST_MS="$(mobile_elapsed_ms "$TEST_START_MS")"
  TOTAL_MS="$(mobile_elapsed_ms "$SPEC_START_MS")"
  echo "[mobile] $spec $SPEC_STATUS reset=$(mobile_format_ms "$RESET_MS") test=$(mobile_format_ms "$TEST_MS") total=$(mobile_format_ms "$TOTAL_MS")"
  mobile_record_timing "$spec" "$SPEC_STATUS" "$RESET_MS" "$TEST_MS" "$TOTAL_MS"
done

mobile_print_timing_report
exit "$EXIT_CODE"
