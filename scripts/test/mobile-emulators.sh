#!/usr/bin/env bash
# Manage a dedicated Android emulator pool for DEV Anywhere mobile tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
EMULATOR_BIN="${ANDROID_EMULATOR:-$SDK_ROOT/emulator/emulator}"
AVD_ROOT="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
AVD_PREFIX="${DEV_ANYWHERE_MOBILE_AVD_PREFIX:-dev-anywhere-mobile}"
SYSTEM_IMAGE_REL="${DEV_ANYWHERE_MOBILE_SYSTEM_IMAGE:-system-images/android-36.1/google_apis_playstore/arm64-v8a/}"
TARGET="${DEV_ANYWHERE_MOBILE_TARGET:-android-36.1}"
COUNT_ARG="${2:-}"
if [[ "$COUNT_ARG" == "--" ]]; then
  COUNT_ARG="${3:-}"
fi
COUNT="${COUNT_ARG:-${DEV_ANYWHERE_MOBILE_EMULATORS:-2}}"
BASE_PORT="${DEV_ANYWHERE_MOBILE_BASE_PORT:-5570}"
START_GAP_SECONDS="${DEV_ANYWHERE_MOBILE_START_GAP_SECONDS:-20}"
ARTIFACT_DIR="${TEST_MOBILE_ARTIFACT_DIR:-$ROOT/artifacts/test-mobile/emulators}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_GPU_MODE="host"
else
  DEFAULT_GPU_MODE="auto"
fi
GPU_MODE="${DEV_ANYWHERE_MOBILE_GPU_MODE:-$DEFAULT_GPU_MODE}"

usage() {
  cat <<EOF
Usage: $0 <create|start|stop|list> [count]

Environment:
  ANDROID_HOME                         Android SDK root. Default: $HOME/Library/Android/sdk
  DEV_ANYWHERE_MOBILE_EMULATORS         Default count. Default: 2
  DEV_ANYWHERE_MOBILE_BASE_PORT         First emulator console port. Default: 5570
  DEV_ANYWHERE_MOBILE_AVD_PREFIX        AVD name prefix. Default: dev-anywhere-mobile
  DEV_ANYWHERE_MOBILE_NO_WINDOW         Start headless when 1. Default: 1
  DEV_ANYWHERE_MOBILE_GPU_MODE          Emulator GPU backend. Default: host on macOS, auto elsewhere
  DEV_ANYWHERE_MOBILE_START_GAP_SECONDS Delay between emulator starts. Default: 20
EOF
}

require_emulator() {
  if [[ ! -x "$EMULATOR_BIN" ]]; then
    echo "ERROR: emulator binary not found: $EMULATOR_BIN" >&2
    exit 2
  fi
}

avd_name() {
  echo "$AVD_PREFIX-$1"
}

avd_port() {
  local index="$1"
  echo $((BASE_PORT + (index - 1) * 2))
}

avd_serial() {
  echo "emulator-$(avd_port "$1")"
}

launch_label() {
  echo "dev.anywhere.mobile.$1"
}

create_one() {
  local index="$1"
  local name dir ini display
  name="$(avd_name "$index")"
  dir="$AVD_ROOT/$name.avd"
  ini="$AVD_ROOT/$name.ini"
  display="DEV Anywhere Mobile $index"

  mkdir -p "$dir"
  cat >"$ini" <<EOF
avd.ini.encoding=UTF-8
path=$dir
path.rel=avd/$name.avd
target=$TARGET
EOF

  cat >"$dir/config.ini" <<EOF
AvdId=$name
PlayStore.enabled=true
abi.type=arm64-v8a
avd.ini.displayname=$display
avd.ini.encoding=UTF-8
disk.dataPartition.size=6G
fastboot.chosenSnapshotFile=
fastboot.forceChosenSnapshotBoot=no
fastboot.forceColdBoot=yes
fastboot.forceFastBoot=no
hw.accelerometer=yes
hw.arc=false
hw.audioInput=yes
hw.battery=yes
hw.camera.back=virtualscene
hw.camera.front=emulated
hw.cpu.arch=arm64
hw.cpu.ncore=2
hw.dPad=no
hw.device.hash2=MD5:2016577e1656e8e7c2adb0fac972beea
hw.device.manufacturer=Generic
hw.device.name=medium_phone
hw.gps=yes
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.gyroscope=yes
hw.initialOrientation=portrait
hw.keyboard=yes
hw.lcd.density=420
hw.lcd.height=2400
hw.lcd.width=1080
hw.mainKeys=no
hw.ramSize=2048
hw.sdCard=yes
hw.sensors.light=yes
hw.sensors.magnetic_field=yes
hw.sensors.orientation=yes
hw.sensors.pressure=yes
hw.sensors.proximity=yes
hw.trackBall=no
image.sysdir.1=$SYSTEM_IMAGE_REL
runtime.network.latency=none
runtime.network.speed=full
sdcard.size=512M
showDeviceFrame=no
skin.dynamic=yes
skin.name=1080x2400
skin.path=1080x2400
tag.display=Google Play
tag.displaynames=Google Play
tag.id=google_apis_playstore
tag.ids=google_apis_playstore
target=$TARGET
vm.heapSize=336
EOF

  echo "[mobile-emulators] created $name"
}

create_pool() {
  mkdir -p "$AVD_ROOT"
  for i in $(seq 1 "$COUNT"); do
    create_one "$i"
  done
}

wait_boot() {
  local serial="$1"
  local deadline booted
  deadline=$((SECONDS + 180))
  adb -s "$serial" wait-for-device >/dev/null
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    booted="$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$booted" == "1" ]]; then
      adb -s "$serial" shell input keyevent 82 >/dev/null 2>&1 || true
      adb -s "$serial" shell settings put secure show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
      adb -s "$serial" shell settings put system show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
      return 0
    fi
    sleep 2
  done
  echo "ERROR: $serial did not boot within 180s" >&2
  return 1
}

start_pool() {
  require_emulator
  create_pool
  mkdir -p "$ARTIFACT_DIR"

  for i in $(seq 1 "$COUNT"); do
    local name port serial label log err_log no_window_arg
    name="$(avd_name "$i")"
    port="$(avd_port "$i")"
    serial="$(avd_serial "$i")"
    label="$(launch_label "$serial")"
    log="$ARTIFACT_DIR/$serial.log"
    err_log="$ARTIFACT_DIR/$serial.err.log"
    no_window_arg=()

    if adb devices 2>/dev/null | awk '{print $1}' | grep -qx "$serial"; then
      echo "[mobile-emulators] $serial already running"
      continue
    fi

    if [[ "${DEV_ANYWHERE_MOBILE_NO_WINDOW:-1}" == "1" ]]; then
      no_window_arg=(-no-window)
    fi

    echo "[mobile-emulators] starting $name as $serial log=$log"
    if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
      launchctl remove "$label" >/dev/null 2>&1 || true
      launchctl submit \
        -l "$label" \
        -o "$log" \
        -e "$err_log" \
        -- "$EMULATOR_BIN" \
        -avd "$name" \
        -port "$port" \
        -no-snapshot-save \
        -no-boot-anim \
        -no-audio \
        -gpu "$GPU_MODE" \
        "${no_window_arg[@]}"
    else
      bash -lc '
        emulator_bin="$1"
        log="$2"
        shift 2
        nohup "$emulator_bin" "$@" >"$log" 2>&1 </dev/null &
        echo $!
      ' _ \
        "$EMULATOR_BIN" \
        "$log" \
        -avd "$name" \
        -port "$port" \
        -no-snapshot-save \
        -no-boot-anim \
        -no-audio \
        -gpu "$GPU_MODE" \
        "${no_window_arg[@]}" \
        >"$ARTIFACT_DIR/$serial.pid"
    fi

    wait_boot "$serial"
    if [[ "$i" -lt "$COUNT" ]]; then
      sleep "$START_GAP_SECONDS"
    fi
  done
}

stop_pool() {
  for i in $(seq 1 "$COUNT"); do
    local serial label
    serial="$(avd_serial "$i")"
    label="$(launch_label "$serial")"
    launchctl remove "$label" >/dev/null 2>&1 || true
    if adb devices 2>/dev/null | awk '{print $1}' | grep -qx "$serial"; then
      echo "[mobile-emulators] stopping $serial"
      adb -s "$serial" emu kill >/dev/null 2>&1 || true
    fi
  done
}

list_pool() {
  require_emulator
  "$EMULATOR_BIN" -list-avds
  adb devices
}

case "${1:-}" in
  create)
    create_pool
    ;;
  start)
    start_pool
    ;;
  stop)
    stop_pool
    ;;
  list)
    list_pool
    ;;
  *)
    usage
    exit 2
    ;;
esac
