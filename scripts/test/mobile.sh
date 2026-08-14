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

if [[ "${ANDROID_SERIAL:-}" != emulator-* && "${TEST_MOBILE_ALLOW_REAL_DEVICE_RESET:-0}" != "1" ]]; then
  echo "ERROR: refusing to configure or reset Chrome on real Android device ${ANDROID_SERIAL:-unknown}." >&2
  echo "Set TEST_MOBILE_ALLOW_REAL_DEVICE_RESET=1 only for a dedicated test device." >&2
  exit 2
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
FAIL_FAST="${TEST_MOBILE_FAIL_FAST:-1}"
RESET_FAIL_FAST="${TEST_MOBILE_RESET_FAIL_FAST:-$FAIL_FAST}"
TIMING_REPORT="$ARTIFACT_DIR/mobile-timing.tsv"
MOBILE_LOCK_ROOT="${TEST_MOBILE_LOCK_ROOT:-${TMPDIR:-/tmp}/dev-anywhere-mobile-locks-${UID:-user}}"
MOBILE_LOCK_PATHS=()
MOBILE_ADB_CONFIGURED=0
PLAYWRIGHT_FLAKY_ARGS=()
if [[ "${PLAYWRIGHT_FAIL_ON_FLAKY_TESTS:-1}" != "0" ]]; then
  PLAYWRIGHT_FLAKY_ARGS+=(--fail-on-flaky-tests)
fi
unset NO_COLOR FORCE_COLOR

mobile_release_run_locks() {
  local i lock_path owner_pid rc
  rc=0
  if [[ "${#MOBILE_LOCK_PATHS[@]}" -eq 0 ]]; then
    return
  fi
  # Release in the reverse of acquisition order. In particular, keep the
  # device lock until every shared host port is free, so a same-device runner
  # cannot enter the hand-off window and immediately fail on an older port lock.
  for ((i = ${#MOBILE_LOCK_PATHS[@]} - 1; i >= 0; i--)); do
    lock_path="${MOBILE_LOCK_PATHS[i]}"
    owner_pid="$(cat "$lock_path/pid" 2>/dev/null || true)"
    if [[ "$owner_pid" != "$$" ]]; then
      echo "ERROR: refusing to release mobile lock not owned by this runner: $lock_path" >&2
      rc=1
      continue
    fi
    if ! rm -f "$lock_path/pid" || ! rmdir "$lock_path"; then
      # Preserve an ownership hint for the explicit stale-lock diagnostic. The
      # directory remains the fail-closed lock even if this write itself fails.
      printf '%s\n' "$$" >"$lock_path/pid" 2>/dev/null || true
      echo "ERROR: failed to release mobile test lock: $lock_path" >&2
      rc=1
    fi
  done
  MOBILE_LOCK_PATHS=()
  return "$rc"
}

mobile_cleanup() {
  local rc=0
  if [[ "$MOBILE_ADB_CONFIGURED" == "1" ]]; then
    e2e_mobile_remove_forward_port "$CDP_PORT" || rc="$?"
    e2e_mobile_teardown_adb_reverse || rc="$?"
  fi
  smoke_cleanup || rc="$?"
  mobile_release_run_locks || rc="$?"
  return "$rc"
}

mobile_on_exit() {
  local original_rc="$?"
  local cleanup_rc=0
  trap - EXIT
  mobile_cleanup || cleanup_rc="$?"
  if [[ "$original_rc" -ne 0 ]]; then
    exit "$original_rc"
  fi
  exit "$cleanup_rc"
}

mobile_acquire_run_lock() {
  local resource safe_resource lock_path owner_pid
  resource="$1"
  safe_resource="$(printf '%s' "$resource" | tr -c '[:alnum:]._-' '_')"
  mkdir -p "$MOBILE_LOCK_ROOT"

  # mkdir is the one canonical lock primitive on every supported host. It is
  # atomic and fail-closed: an interrupted owner leaves one explicit stale
  # directory, instead of allowing shlock/non-shlock runners to take two
  # different lock paths for the same resource.
  lock_path="$MOBILE_LOCK_ROOT/$safe_resource.lock"
  if ! mkdir "$lock_path" 2>/dev/null; then
    owner_pid="$(cat "$lock_path/pid" 2>/dev/null || true)"
    echo "ERROR: mobile test resource '$resource' is already locked by pid ${owner_pid:-unknown}." >&2
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
      echo "The owner is gone; remove only this stale lock: $lock_path" >&2
    else
      echo "Wait for that test run to finish instead of sharing its emulator or ports." >&2
    fi
    return 1
  fi
  if ! printf '%s\n' "$$" >"$lock_path/pid"; then
    rmdir "$lock_path" 2>/dev/null || true
    echo "ERROR: failed to record ownership for mobile test resource '$resource'." >&2
    return 1
  fi
  MOBILE_LOCK_PATHS+=("$lock_path")
}

mkdir -p "$ARTIFACT_DIR"
trap mobile_on_exit EXIT
mobile_acquire_run_lock "device-${ANDROID_SERIAL}"
mobile_acquire_run_lock "tcp-${CDP_PORT}"
mobile_acquire_run_lock "tcp-${TIER_MOBILE_VITE_PORT}"
mobile_acquire_run_lock "tcp-${TIER_MOBILE_RELAY_PORT}"
smoke_use_stable_node
if lsof -nP -iTCP:"$TIER_MOBILE_RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: mobile test Relay port $TIER_MOBILE_RELAY_PORT is already in use." >&2
  echo "The first Android navigation must not connect to an unrelated Relay before test fixtures install." >&2
  exit 2
fi
if curl --noproxy '*' -fsS -m 1 "$BASE_URL" >/dev/null 2>&1 || \
  lsof -nP -iTCP:"$TIER_MOBILE_VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: mobile test Vite port $TIER_MOBILE_VITE_PORT is already in use." >&2
  echo "The mobile gate requires a Vite process it started with an isolated Relay target." >&2
  exit 2
fi
export DEV_ANYWHERE_WEB_RELAY_TARGET="http://127.0.0.1:${TIER_MOBILE_RELAY_PORT}"
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL" "$TIER_MOBILE_VITE_PORT"
if [[ -z "$SMOKE_STARTED_VITE_PID" || -z "$SMOKE_STARTED_VITE_LISTENER_PIDS" ]]; then
  echo "ERROR: mobile test Vite listener ownership was not established." >&2
  exit 2
fi
MOBILE_ADB_CONFIGURED=1
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
  # A new CDP target gets a fresh document and fresh addInitScript registry, so
  # spec isolation does not require restarting Chrome. Restarting per spec makes
  # Android accumulate hidden Chrome document tasks until DevTools stops exposing
  # a page even though its socket is alive.
  local new_id stale_ids
  new_id="$(curl --noproxy '*' -sS -m 5 -X PUT \
    "http://localhost:$CDP_PORT/json/new?about%3Ablank" | python3 -c \
    "import json, sys; print(json.load(sys.stdin).get('id', ''))" 2>/dev/null || true)"
  if [[ -z "$new_id" ]]; then
    echo "ERROR: failed to create a clean Chrome page target" >&2
    return 1
  fi

  stale_ids="$(curl --noproxy '*' -s -m 2 "http://localhost:$CDP_PORT/json" | NEW_ID="$new_id" python3 -c \
    "import json, os, sys
targets = json.load(sys.stdin)
pages = [t for t in targets if t.get('type') == 'page' and t.get('id')]
keep = os.environ['NEW_ID']
print(' '.join(t.get('id') for t in pages if t.get('id') != keep))" 2>/dev/null || true)"

  for id in $stale_ids; do
    curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json/close/$id" >/dev/null || true
  done

  # Avoid a blind sleep. Most closes settle immediately, but poll briefly so the
  # next Playwright attach does not race stale tab removal.
  for _ in $(seq 1 20); do
    if curl --noproxy '*' -s -m 1 "http://localhost:$CDP_PORT/json" | NEW_ID="$new_id" python3 -c \
      "import json, os, sys; targets=json.load(sys.stdin); pages=[t for t in targets if t.get('type') == 'page']; sys.exit(0 if len(pages) == 1 and pages[0].get('id') == os.environ['NEW_ID'] else 1)" \
      >/dev/null 2>&1; then
      if curl --noproxy '*' -fsS -m 2 "http://localhost:$CDP_PORT/json/activate/$new_id" \
        >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 0.1
  done
  echo "ERROR: stale Chrome page targets did not close" >&2
  return 1
}

mobile_wait_for_chrome_exit() {
  local process_list absent_samples
  absent_samples=0
  for _ in $(seq 1 100); do
    if ! process_list="$(adb shell ps -A -o NAME 2>/dev/null | tr -d '\r')"; then
      absent_samples=0
      sleep 0.1
      continue
    fi
    if grep -Fxq 'com.android.chrome' <<<"$process_list"; then
      absent_samples=0
    else
      absent_samples=$((absent_samples + 1))
      if [[ "$absent_samples" -ge 3 ]]; then
        return 0
      fi
    fi
    sleep 0.1
  done
  echo "ERROR: Chrome main process did not exit after force-stop" >&2
  return 1
}

# Android Chrome over CDP 不支持 newContext 隔离，addInitScript 也不能 unregister。
# 每个 spec 用 /json/new 创建干净 target、关闭旧 target；Chrome 进程只在整套首次
# 不可用时冷启动。这样既隔离 init script，也不会因逐 spec force-stop 累积 hidden task。
reset_chrome() {
  # A failed/interrupted orientation test cannot poison later specs.
  if ! adb shell settings put system accelerometer_rotation 0 >/dev/null 2>&1; then
    echo "ERROR: failed to disable Android auto-rotation" >&2
    return 1
  fi
  if ! adb shell settings put system user_rotation 0 >/dev/null 2>&1; then
    echo "ERROR: failed to reset Android orientation" >&2
    return 1
  fi
  adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
  if ! e2e_mobile_setup_adb_reverse; then
    echo "ERROR: failed to restore Android reverse ports" >&2
    return 1
  fi
  if ! adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null 2>&1; then
    echo "ERROR: failed to restore the Chrome DevTools forward" >&2
    return 1
  fi

  if ! mobile_cdp_ready; then
    if ! adb shell am force-stop com.android.chrome >/dev/null 2>&1; then
      echo "ERROR: failed to stop Android Chrome for a cold start" >&2
      return 1
    fi
    mobile_wait_for_chrome_exit || return 1
    if ! adb -s "$ANDROID_SERIAL" forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1; then
      echo "ERROR: failed to remove the stale Chrome DevTools forward" >&2
      return 1
    fi
    if ! adb shell am start -W -a android.intent.action.VIEW -d "$DEVICE_BASE_URL/" >/dev/null 2>&1; then
      echo "ERROR: failed to cold-start Android Chrome" >&2
      return 1
    fi
    e2e_mobile_accept_chrome_first_run >/dev/null 2>&1 || true
    mobile_wait_for_cdp_page || {
      echo "ERROR: Chrome cold start produced no CDP page target" >&2
      return 1
    }
  fi

  mobile_replace_page_target
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
  local spec="$1" spec_key output_dir
  spec_key="$(basename "$spec" .spec.ts)"
  output_dir="$ARTIFACT_DIR/playwright/$spec_key"
  mkdir -p "$output_dir"
  if ((${#PLAYWRIGHT_FLAKY_ARGS[@]})); then
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      ./node_modules/.bin/playwright test --project=device-mobile-android --workers=1 --retries=0 --max-failures=1 --output "$output_dir" "${PLAYWRIGHT_FLAKY_ARGS[@]}" "$spec"
  else
    WEB_BASE_URL="$BASE_URL" \
      MOBILE_VITE_BASE_URL="$DEVICE_BASE_URL" \
      MOBILE_CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT" \
      ./node_modules/.bin/playwright test --project=device-mobile-android --workers=1 --retries=0 --max-failures=1 --output "$output_dir" "$spec"
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
  if [[ "$SPEC_STATUS" != "passed" && "$FAIL_FAST" == "1" ]]; then
    echo "[mobile] stopping after first failed spec (set TEST_MOBILE_FAIL_FAST=0 only for diagnostics)"
    break
  fi
done

mobile_print_timing_report
exit "$EXIT_CODE"
