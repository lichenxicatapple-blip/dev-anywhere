#!/usr/bin/env bash
# 四层测试 helper. tier: unit / layout / pc / mobile.

# L4 mobile (Android emu) 用 5174/6100, 让用户开发的 5173/3100 留空.
TIER_MOBILE_VITE_PORT="${TIER_MOBILE_VITE_PORT:-5174}"
TIER_MOBILE_RELAY_PORT="${TIER_MOBILE_RELAY_PORT:-6100}"

e2e_fixtures_runtime_dir() {
  local root="$1"
  echo "$root/apps/web/e2e/fixtures/sessions/.runtime"
}

# 0 = 可跑 mobile tier; 1 = 跳过.
e2e_mobile_emulator_ready() {
  command -v adb >/dev/null 2>&1 || return 1
  adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {f=1} END {exit f?0:1}'
}

e2e_mobile_setup_adb_reverse() {
  local v="${1:-$TIER_MOBILE_VITE_PORT}"
  local r="${2:-$TIER_MOBILE_RELAY_PORT}"
  adb reverse "tcp:$v" "tcp:$v" >/dev/null
  adb reverse "tcp:$r" "tcp:$r" >/dev/null
}

e2e_mobile_teardown_adb_reverse() {
  local v="${1:-$TIER_MOBILE_VITE_PORT}"
  local r="${2:-$TIER_MOBILE_RELAY_PORT}"
  adb reverse --remove "tcp:$v" 2>/dev/null || true
  adb reverse --remove "tcp:$r" 2>/dev/null || true
}
