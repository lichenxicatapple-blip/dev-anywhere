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

e2e_mobile_remove_forward_port() {
  local host_port="$1"

  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    adb -s "$ANDROID_SERIAL" forward --remove "tcp:$host_port" >/dev/null 2>&1 || true
    return
  fi

  adb forward --remove "tcp:$host_port" >/dev/null 2>&1 || true
}

e2e_mobile_prepare_soft_keyboard() {
  # Android emulators often expose a hardware keyboard to Chrome. Make the IME visible
  # anyway so mobile keyboard-layout tests exercise the same viewport path as phones.
  if [[ "${ANDROID_SERIAL:-}" == emulator-* ]]; then
    adb shell settings put secure show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
    adb shell settings put system show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
  fi
}

e2e_mobile_tap_ui_node() {
  local coords

  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || return 1
  coords="$(
    adb exec-out cat /sdcard/window.xml 2>/dev/null | python3 -c \
      "import re, sys, xml.etree.ElementTree as ET
wanted = set(sys.argv[1:])
try:
    root = ET.fromstring(sys.stdin.read())
except Exception:
    sys.exit(1)
for node in root.iter('node'):
    text = node.attrib.get('text', '')
    resource_id = node.attrib.get('resource-id', '')
    if text not in wanted and resource_id not in wanted:
        continue
    match = re.fullmatch(r'\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]', node.attrib.get('bounds', ''))
    if not match:
        continue
    x1, y1, x2, y2 = map(int, match.groups())
    print((x1 + x2) // 2, (y1 + y2) // 2)
    sys.exit(0)
sys.exit(1)" "$@"
  )" || return 1

  [[ -n "$coords" ]] || return 1
  adb shell input tap $coords >/dev/null 2>&1
}

e2e_mobile_accept_chrome_first_run() {
  local _attempt

  for _attempt in $(seq 1 5); do
    if ! adb shell dumpsys activity activities 2>/dev/null | grep -q 'org.chromium.chrome.browser.firstrun.FirstRunActivity'; then
      return 0
    fi

    if e2e_mobile_tap_ui_node \
      'com.android.chrome:id/signin_fre_dismiss_button' \
      'com.android.chrome:id/terms_accept' \
      'com.android.chrome:id/negative_button' \
      'Use without an account' \
      'Accept & continue' \
      'No thanks' \
      'Got it' \
      'Continue' \
      'Skip'; then
      sleep 1
      continue
    fi

    sleep 1
  done

  ! adb shell dumpsys activity activities 2>/dev/null | grep -q 'org.chromium.chrome.browser.firstrun.FirstRunActivity'
}

e2e_mobile_teardown_adb_reverse() {
  local v="${1:-$TIER_MOBILE_VITE_PORT}"
  local r="${2:-$TIER_MOBILE_RELAY_PORT}"
  adb reverse --remove "tcp:$v" 2>/dev/null || true
  adb reverse --remove "tcp:$r" 2>/dev/null || true
}
