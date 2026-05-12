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

mkdir -p "$ARTIFACT_DIR"
trap 'e2e_mobile_teardown_adb_reverse; smoke_cleanup' EXIT
smoke_use_stable_node
smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"
e2e_mobile_setup_adb_reverse

echo "[mobile] vite=$BASE_URL relay=:${TIER_MOBILE_RELAY_PORT} adb=$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | xargs)"
echo "[mobile] Phase 1 骨架就位; Phase 2 接 CDP headless 跑器 (lib 抽自 scripts/emu-debug.mjs)."
