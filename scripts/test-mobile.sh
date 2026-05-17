#!/usr/bin/env bash
# Tier 4 - 真 Android 模拟器 + Chrome CDP. 缺 emu 自动跳过 + 退 0 (PR 闸不卡).
# 强制要求 emu: 设 TEST_MOBILE_REQUIRE_EMULATOR=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/e2e-tiers.sh"
source "$ROOT/scripts/lib/smoke-common.sh"

REQUIRE="${TEST_MOBILE_REQUIRE_EMULATOR:-0}"

if ! e2e_mobile_emulator_ready; then
  if [[ "$REQUIRE" == "1" ]]; then
    echo "ERROR: TEST_MOBILE_REQUIRE_EMULATOR=1 but no Android device online via adb." >&2
    exit 2
  fi
  echo "[mobile] No Android emulator online — skipping (set TEST_MOBILE_REQUIRE_EMULATOR=1 to fail instead)."
  exit 0
fi

ARTIFACT_DIR="${ROOT}/artifacts/test-mobile"
BASE_URL="http://127.0.0.1:${TIER_MOBILE_VITE_PORT}"
CDP_PORT="${TIER_MOBILE_CDP_PORT:-9222}"

mkdir -p "$ARTIFACT_DIR"
trap 'adb forward --remove "tcp:$CDP_PORT" 2>/dev/null || true; e2e_mobile_teardown_adb_reverse; smoke_cleanup' EXIT
smoke_use_stable_node
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"
e2e_mobile_setup_adb_reverse
e2e_mobile_prepare_soft_keyboard
adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null

echo "[mobile] vite=$BASE_URL relay=:${TIER_MOBILE_RELAY_PORT} cdp=:$CDP_PORT adb=${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | xargs)}"

cd "$ROOT/apps/web"

mobile_cdp_ready() {
  curl -s -m 2 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1
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
  sleep 2
  adb shell am start -a android.intent.action.VIEW -d "$BASE_URL/" >/dev/null 2>&1
  sleep 6
  adb forward "tcp:$CDP_PORT" "localabstract:chrome_devtools_remote" >/dev/null
  # 头两次 spec 跑撞冷启动 emu chrome 需要 ~25s 才注册 chrome_devtools_remote;
  # 旧 5 × 2s 过紧, 给 15 × 2s = 30s 兜底, 之后 spec 已 warm 不会等满。
  for _ in $(seq 1 15); do
    if mobile_cdp_ready; then
      break
    fi
    sleep 2
  done
  if ! mobile_cdp_ready; then
    echo "ERROR: chrome 重启后 CDP 30s 内仍不响应" >&2
    return 1
  fi
  # 关掉除 [0] 之外所有 stale tab. python3 拆 json (jq 不一定全装).
  STALE_IDS="$(curl -s "http://localhost:$CDP_PORT/json" | python3 -c \
    "import json, sys; print(' '.join(t['id'] for t in json.load(sys.stdin)[1:]))" 2>/dev/null || true)"
  for id in $STALE_IDS; do
    curl -s "http://localhost:$CDP_PORT/json/close/$id" >/dev/null || true
  done
  sleep 1
}

if [[ "$#" -gt 0 ]]; then
  SPECS=("$@")
else
  # macOS 默认 bash 3.2 没 mapfile, 用 glob 展开
  SPECS=(e2e/mobile/*.spec.ts)
fi

EXIT_CODE=0
for spec in "${SPECS[@]}"; do
  echo ""
  echo "=== $spec ==="
  reset_chrome || { EXIT_CODE=1; continue; }
  # WEB_BASE_URL 给 helpers.ts 的 BASE_URL (selectFakeProxy / gotoWithFakeProxy 等),
  # mobile 跑独立 vite 在 5174 不是 host 5173, 不让 helpers 默认值 5173 把 emu 带去
  # connection refused。
  WEB_BASE_URL="$BASE_URL" \
  MOBILE_VITE_BASE_URL="$BASE_URL" \
  MOBILE_CDP_ENDPOINT="http://localhost:$CDP_PORT" \
    ./node_modules/.bin/playwright test --project=device-mobile-android --workers=1 "$spec" || EXIT_CODE=$?
done

exit "$EXIT_CODE"
