#!/usr/bin/env bash
# 四层测试 helper. tier: unit / layout / pc / mobile.

# L4 mobile (Android emu) 用 5174/6100, 让用户开发的 5173/3100 留空.
TIER_MOBILE_VITE_PORT="${TIER_MOBILE_VITE_PORT:-5174}"
TIER_MOBILE_RELAY_PORT="${TIER_MOBILE_RELAY_PORT:-6100}"

e2e_fixtures_runtime_dir() {
  local root="$1"
  echo "$root/apps/web/e2e/fixtures/sessions/.runtime"
}

e2e_mobile_select_adb_device() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    return 0
  fi

  local serial
  serial="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" && $1 ~ /^emulator-/ {print $1; exit}')"
  if [[ -z "$serial" ]]; then
    serial="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}')"
  fi
  if [[ -z "$serial" ]]; then
    return 1
  fi
  export ANDROID_SERIAL="$serial"
}

# 0 = 可跑 mobile tier; 1 = 跳过.
e2e_mobile_emulator_ready() {
  command -v adb >/dev/null 2>&1 || return 1
  e2e_mobile_select_adb_device || return 1
  adb get-state >/dev/null 2>&1
}

e2e_mobile_setup_adb_reverse() {
  local v="${1:-$TIER_MOBILE_VITE_PORT}"
  local r="${2:-$TIER_MOBILE_RELAY_PORT}"
  adb reverse "tcp:$v" "tcp:$v" >/dev/null
  adb reverse "tcp:$r" "tcp:$r" >/dev/null
}

e2e_mobile_prepare_soft_keyboard() {
  # Android emulators often expose a hardware keyboard to Chrome. Make the IME visible
  # anyway so mobile keyboard-layout tests exercise the same viewport path as phones.
  if [[ "${ANDROID_SERIAL:-}" == emulator-* ]]; then
    adb shell settings put secure show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
  fi
}

e2e_mobile_teardown_adb_reverse() {
  local v="${1:-$TIER_MOBILE_VITE_PORT}"
  local r="${2:-$TIER_MOBILE_RELAY_PORT}"
  adb reverse --remove "tcp:$v" 2>/dev/null || true
  adb reverse --remove "tcp:$r" 2>/dev/null || true
}
