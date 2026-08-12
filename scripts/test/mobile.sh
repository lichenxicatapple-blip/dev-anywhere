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
DEVICE_BASE_URL="${TEST_MOBILE_DEVICE_BASE_URL:-$BASE_URL}"
CDP_PORT="${TIER_MOBILE_CDP_PORT:-9222}"
CDP_READY_TIMEOUT_SECONDS="${TEST_MOBILE_CDP_READY_TIMEOUT_SECONDS:-60}"
CDP_READY_POLL_SECONDS="${TEST_MOBILE_CDP_READY_POLL_SECONDS:-0.25}"
TIMING_REPORT="$ARTIFACT_DIR/mobile-timing.tsv"
PLAYWRIGHT_FLAKY_ARGS=()
if [[ "${PLAYWRIGHT_FAIL_ON_FLAKY_TESTS:-1}" != "0" ]]; then
  PLAYWRIGHT_FLAKY_ARGS+=(--fail-on-flaky-tests)
fi
unset NO_COLOR FORCE_COLOR

mkdir -p "$ARTIFACT_DIR"
trap 'e2e_mobile_remove_forward_port "$CDP_PORT"; e2e_mobile_teardown_adb_reverse; smoke_cleanup' EXIT
smoke_use_stable_node
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL" "$TIER_MOBILE_VITE_PORT"
e2e_mobile_setup_adb_reverse
e2e_mobile_prepare_soft_keyboard
adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null

echo "[mobile] vite=$BASE_URL device-vite=$DEVICE_BASE_URL relay=:${TIER_MOBILE_RELAY_PORT} cdp=:$CDP_PORT adb=${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | xargs)}"

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

mobile_wait_for_chrome_exit() {
  local process_list absent_checks=0
  for _ in $(seq 1 100); do
    process_list="$(adb shell ps -A -o NAME 2>/dev/null | tr -d '\r' || true)"
    # grep -E uses POSIX ERE, not PCRE. A non-capturing group (`(?:...)`)
    # makes GNU grep reject the pattern and falsely report that Chrome exited,
    # racing the following start against the still-running force-stop.
    # force-stop may leave an isolated `com.android.chrome:*` service behind on
    # the hosted image. It cannot own the Activity or DevTools socket; the main
    # package process is the lifecycle boundary that must be gone before start.
    if ! grep -Fxq 'com.android.chrome' <<<"$process_list"; then
      absent_checks=$((absent_checks + 1))
      # force-stop tears down several Chrome processes and its Activity in
      # stages. A single empty ps sample is only a transition window; require a
      # full second of stable absence before launching the replacement process.
      if [[ "$absent_checks" -ge 10 ]]; then
        return 0
      fi
    else
      absent_checks=0
    fi
    sleep 0.1
  done
  echo "ERROR: Chrome main process did not exit after force-stop" >&2
  echo "[mobile] Chrome processes still present:" >&2
  grep -E '^com\.android\.chrome(:|$)' <<<"$process_list" >&2 || true
  return 1
}

mobile_cold_start_chrome() {
  local chrome_activity start_output
  adb shell am force-stop com.android.chrome >/dev/null 2>&1 || true
  mobile_wait_for_chrome_exit || return 1
  e2e_mobile_remove_forward_port "$CDP_PORT"

  # After force-stop, an implicit VIEW intent can be accepted without bringing
  # Chrome back to the foreground on the hosted emulator. Resolve Chrome's own
  # activity and launch that component explicitly. Resolve instead of hardcoding
  # com.google.android.apps.chrome.Main so this survives Chrome package changes.
  chrome_activity="$(
    adb shell cmd package resolve-activity --brief \
      -a android.intent.action.VIEW \
      -c android.intent.category.BROWSABLE \
      -p com.android.chrome \
      -d "$DEVICE_BASE_URL/" \
      2>/dev/null | tr -d '\r' | tail -n 1
  )"
  if [[ "$chrome_activity" != com.android.chrome/* ]]; then
    echo "ERROR: could not resolve Chrome VIEW activity: ${chrome_activity:-<empty>}" >&2
    return 1
  fi

  if ! start_output="$(
    adb shell am start -W \
      -n "$chrome_activity" \
      -a android.intent.action.VIEW \
      -c android.intent.category.BROWSABLE \
      -d "$DEVICE_BASE_URL/" 2>&1
  )"; then
    echo "ERROR: failed to start Chrome activity $chrome_activity" >&2
    echo "$start_output" >&2
    return 1
  fi
  e2e_mobile_accept_chrome_first_run >/dev/null 2>&1 || true
  mobile_wait_for_cdp_page || {
    echo "ERROR: Chrome cold start produced no CDP page target" >&2
    echo "[mobile] Chrome start result:" >&2
    echo "$start_output" >&2
    echo "[mobile] Chrome processes after failed start:" >&2
    adb shell ps -A -o PID,NAME 2>/dev/null | grep -E '(^|[[:space:]])com\.android\.chrome(:|$)' >&2 || true
    return 1
  }

}

# Android Chrome over CDP 不支持 newContext 隔离。整套门禁只启动一次 Chrome，
# Playwright 也只 attach 一次；fixtures/cdp.ts 为每个 test 创建独立 target，隔离
# addInitScript 和页面状态。避免跨进程反复 attach 和 force-stop 的两类 Chrome 竞态。
reset_chrome() {
  if [[ "${ANDROID_SERIAL:-}" != emulator-* && "${TEST_MOBILE_ALLOW_REAL_DEVICE_RESET:-0}" != "1" ]]; then
    echo "ERROR: refusing to reset Chrome on real Android device ${ANDROID_SERIAL:-unknown}." >&2
    echo "Set TEST_MOBILE_ALLOW_REAL_DEVICE_RESET=1 only for a dedicated test device." >&2
    return 1
  fi
  # A failed/interrupted orientation test cannot poison later specs.
  adb shell settings put system accelerometer_rotation 0 >/dev/null 2>&1
  adb shell settings put system user_rotation 0 >/dev/null 2>&1
  adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
  e2e_mobile_setup_adb_reverse
  adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null 2>&1 || true

  if ! mobile_cdp_ready; then
    mobile_cold_start_chrome || return 1
  fi
  mobile_wait_for_cdp_page
}

if [[ "$#" -gt 0 ]]; then
  SPECS=("$@")
else
  # macOS 默认 bash 3.2 没 mapfile, 用 glob 展开
  SPECS=(e2e/mobile/*.spec.ts)
fi

mobile_run_playwright_suite() {
  if ((${#PLAYWRIGHT_FLAKY_ARGS[@]})); then
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      ./node_modules/.bin/playwright test \
      --project=device-mobile-android \
      --workers=1 \
      --retries=0 \
      --max-failures=1 \
      "${PLAYWRIGHT_FLAKY_ARGS[@]}" \
      "${SPECS[@]}"
  else
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      ./node_modules/.bin/playwright test \
      --project=device-mobile-android \
      --workers=1 \
      --retries=0 \
      --max-failures=1 \
      "${SPECS[@]}"
  fi
}

SUITE_START_MS="$(mobile_now_ms)"
RESET_START_MS="$SUITE_START_MS"
if ! reset_chrome; then
  RESET_MS="$(mobile_elapsed_ms "$RESET_START_MS")"
  echo "[mobile] suite browser start failed after $(mobile_format_ms "$RESET_MS")" >&2
  exit 1
fi
RESET_MS="$(mobile_elapsed_ms "$RESET_START_MS")"
TEST_START_MS="$(mobile_now_ms)"

# WEB_BASE_URL 给 helpers.ts 的 BASE_URL (selectFakeProxy / gotoWithFakeProxy 等),
# mobile 跑独立 vite 在 5174 不是 host 5173, 不让 emu 带去 connection refused。
if mobile_run_playwright_suite; then
  EXIT_CODE=0
else
  EXIT_CODE="$?"
fi
TEST_MS="$(mobile_elapsed_ms "$TEST_START_MS")"
TOTAL_MS="$(mobile_elapsed_ms "$SUITE_START_MS")"
printf 'scope\tstatus\treset_s\ttest_s\ttotal_s\n' >"$TIMING_REPORT"
printf 'all-mobile-specs\t%s\t%.3f\t%.3f\t%.3f\n' \
  "$([[ "$EXIT_CODE" -eq 0 ]] && echo passed || echo "failed($EXIT_CODE)")" \
  "$(awk -v ms="$RESET_MS" 'BEGIN { print ms / 1000 }')" \
  "$(awk -v ms="$TEST_MS" 'BEGIN { print ms / 1000 }')" \
  "$(awk -v ms="$TOTAL_MS" 'BEGIN { print ms / 1000 }')" \
  >>"$TIMING_REPORT"
echo "[mobile] timing report: $TIMING_REPORT"
echo "[mobile] total reset=$(mobile_format_ms "$RESET_MS") test=$(mobile_format_ms "$TEST_MS") wall=$(mobile_format_ms "$TOTAL_MS")"
exit "$EXIT_CODE"
