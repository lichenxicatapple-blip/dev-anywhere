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
RESET_FAIL_FAST="${TEST_MOBILE_RESET_FAIL_FAST:-0}"
FAIL_FAST="${TEST_MOBILE_FAIL_FAST:-0}"
CHROME_MAX_SPECS_PER_PROCESS="${TEST_MOBILE_CHROME_MAX_SPECS_PER_PROCESS:-4}"
CHROME_SPECS_IN_PROCESS=0
CHROME_TARGET_SEQUENCE=0
ACTIVE_TARGET_URL=""
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

mobile_replace_page_target() {
  # A new CDP target gets a fresh document and fresh addInitScript registry. Do
  # not close the previous target here: Android Chrome can asynchronously carry
  # that close into the newly activated target after our health probe succeeds.
  # The process-level batch limit bounds these retained targets and clears all of
  # them at the next cold start.
  local new_id target_url healthy_checks encoded_url
  CHROME_TARGET_SEQUENCE=$((CHROME_TARGET_SEQUENCE + 1))
  target_url="about:blank#dev-anywhere-e2e-$CHROME_TARGET_SEQUENCE"
  encoded_url="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$target_url")"
  new_id="$(curl --noproxy '*' -sS -m 5 -X PUT \
    "http://localhost:$CDP_PORT/json/new?$encoded_url" | python3 -c \
    "import json, sys; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null || true)"
  if [[ -z "$new_id" ]]; then
    echo "ERROR: failed to create a clean Chrome page target" >&2
    return 1
  fi

  # Make the dedicated target foreground, then require it to remain visible to
  # CDP. Playwright receives its unique URL and attaches to this exact page.
  if ! curl --noproxy '*' -fsS -m 2 "http://localhost:$CDP_PORT/json/activate/$new_id" \
    >/dev/null 2>&1; then
    echo "ERROR: failed to activate the clean Chrome page target" >&2
    return 1
  fi

  healthy_checks=0
  for _ in $(seq 1 30); do
    if curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json" | NEW_ID="$new_id" TARGET_URL="$target_url" python3 -c \
      "import json, os, sys; targets=json.load(sys.stdin); sys.exit(0 if any(t.get('type') == 'page' and t.get('id') == os.environ['NEW_ID'] and t.get('url') == os.environ['TARGET_URL'] for t in targets) else 1)" \
      >/dev/null 2>&1; then
      healthy_checks=$((healthy_checks + 1))
      if [[ "$healthy_checks" -ge 5 ]]; then
        ACTIVE_TARGET_URL="$target_url"
        return 0
      fi
    else
      healthy_checks=0
    fi
    sleep 0.1
  done
  echo "ERROR: dedicated Chrome page target did not remain healthy" >&2
  return 1
}

mobile_wait_for_chrome_exit() {
  local process_list absent_checks=0
  for _ in $(seq 1 100); do
    process_list="$(adb shell ps -A -o NAME 2>/dev/null | tr -d '\r' || true)"
    # grep -E uses POSIX ERE, not PCRE. A non-capturing group (`(?:...)`)
    # makes GNU grep reject the pattern and falsely report that Chrome exited,
    # racing the following start against the still-running force-stop.
    if ! grep -Eq '^com\.android\.chrome(:|$)' <<<"$process_list"; then
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
  echo "ERROR: Chrome processes did not exit after force-stop" >&2
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

  # The VIEW intent's startup target is owned by Chrome's native launch flow
  # and may be replaced when tab/session restoration finishes. Never hand that
  # ephemeral target to Playwright. Create the same dedicated, foreground,
  # consecutively-healthy target used for ordinary spec isolation.
  mobile_replace_page_target || {
    echo "ERROR: Chrome cold start did not produce a stable test page target" >&2
    return 1
  }
}

# Android Chrome over CDP 不支持 newContext 隔离，addInitScript 也不能 unregister。
# 每个 spec 用 /json/new 创建一个有唯一 URL 的干净 target；批次内保留旧 target，
# 避免 Android Chrome 的异步 close 杀掉刚激活的新 target。同一进程最多承载固定
# 数量的 spec，再主动冷启动，一次清理所有旧 target。分批回收同时给 target 和进程
# 生命周期设置上界。
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

  if ! mobile_cdp_ready || [[ "$CHROME_SPECS_IN_PROCESS" -ge "$CHROME_MAX_SPECS_PER_PROCESS" ]]; then
    mobile_cold_start_chrome || return 1
    CHROME_SPECS_IN_PROCESS=1
    return 0
  fi

  if mobile_replace_page_target; then
    CHROME_SPECS_IN_PROCESS=$((CHROME_SPECS_IN_PROCESS + 1))
    return 0
  fi

  # A process may die between the initial /json/version probe and target
  # replacement. Recover once with a real cold start; business assertions still
  # get their normal fail-fast behavior after the browser is healthy.
  echo "[mobile] Chrome target reset was unhealthy; recovering with a cold start" >&2
  mobile_cold_start_chrome || return 1
  CHROME_SPECS_IN_PROCESS=1
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
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      MOBILE_CDP_TARGET_URL="$ACTIVE_TARGET_URL" \
      ./node_modules/.bin/playwright test \
      --project=device-mobile-android \
      --workers=1 \
      --retries=0 \
      --max-failures=1 \
      "${PLAYWRIGHT_FLAKY_ARGS[@]}" \
      "$spec"
  else
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      MOBILE_CDP_TARGET_URL="$ACTIVE_TARGET_URL" \
      ./node_modules/.bin/playwright test \
      --project=device-mobile-android \
      --workers=1 \
      --retries=0 \
      --max-failures=1 \
      "$spec"
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
    # A browser reset failure means the spec never ran. The release gate's
    # general fail-fast setting must cover infrastructure failures as well as
    # Playwright assertion failures; otherwise every remaining spec burns its
    # full CDP timeout against the same broken browser.
    if [[ "$RESET_FAIL_FAST" == "1" || "$FAIL_FAST" == "1" ]]; then
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
  if [[ "$SPEC_STATUS" != "passed" && "$FAIL_FAST" == "1" ]]; then
    break
  fi
done

mobile_print_timing_report
exit "$EXIT_CODE"
