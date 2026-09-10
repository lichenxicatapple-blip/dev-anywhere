#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-emulator-test.XXXXXX")"
REAL_UNAME="$(command -v uname)"
cleanup() {
  local target parent
  target="$(realpath "$TEST_DIR")"
  parent="$(realpath "${TMPDIR:-/tmp}")"
  [[ "$(dirname "$target")" == "$parent" && "$(basename "$target")" == dev-anywhere-emulator-test.* ]] || return 1
  rm -rf -- "$target"
}
trap cleanup EXIT
mkdir -p "$TEST_DIR/bin"
cat >"$TEST_DIR/bin/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-m" ]]; then
  printf '%s\n' "$TEST_HOST_ARCH"
else
  "$REAL_UNAME" "$@"
fi
STUB
chmod +x "$TEST_DIR/bin/uname"

check_config() {
  local host_arch="$1" expected_abi="$2" expected_cpu="$3" image="${4:-}"
  local avd_root="$TEST_DIR/avd-$host_arch-$expected_abi"
  PATH="$TEST_DIR/bin:$PATH" REAL_UNAME="$REAL_UNAME" TEST_HOST_ARCH="$host_arch" \
    ANDROID_AVD_HOME="$avd_root" DEV_ANYWHERE_MOBILE_AVD_PREFIX="release-test" \
    DEV_ANYWHERE_MOBILE_SYSTEM_IMAGE="$image" \
    bash "$ROOT/scripts/test/mobile-emulators.sh" create 1 >/dev/null
  local config="$avd_root/release-test-1.avd/config.ini"
  grep -Fxq "abi.type=$expected_abi" "$config"
  grep -Fxq "hw.cpu.arch=$expected_cpu" "$config"
  grep -Fxq "image.sysdir.1=${image:-system-images/android-36.1/google_apis_playstore/$expected_abi/}" "$config"
}

check_config x86_64 x86_64 x86_64
check_config arm64 arm64-v8a arm64
check_config x86_64 arm64-v8a arm64 "system-images/android-36.1/google_apis_playstore/arm64-v8a/"
echo "mobile emulator architecture tests passed"
