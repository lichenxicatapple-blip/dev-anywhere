#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_CURL_BIN="$(command -v curl)"
REAL_LSOF_BIN="$(command -v lsof)"
REAL_PYTHON_BIN="$(command -v python3)"
REAL_RMDIR_BIN="$(command -v rmdir)"
SYSTEM_PATH="$PATH"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-mobile-runner.XXXXXX")"
RUNNER_ROOT="$TEST_ROOT/repo"
FAKE_BIN="$TEST_ROOT/bin"
EXTERNAL_PID_FILE="$TEST_ROOT/external-pids"

cleanup() {
  local pid
  if [[ -f "$EXTERNAL_PID_FILE" ]]; then
    while IFS= read -r pid; do
      if [[ "$pid" =~ ^[0-9]+$ ]]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
      fi
    done <"$EXTERNAL_PID_FILE"
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "mobile runner behavior test failed: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label: expected '$expected', got '$actual'"
}

assert_contains() {
  local file="$1"
  local needle="$2"
  [[ -f "$file" ]] || fail "missing file for assertion: $file"
  grep -F -- "$needle" "$file" >/dev/null || fail "$file does not contain: $needle"
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if [[ -f "$file" ]] && grep -F -- "$needle" "$file" >/dev/null; then
    fail "$file unexpectedly contains: $needle"
  fi
}

mkdir -p \
  "$RUNNER_ROOT/scripts/test" \
  "$RUNNER_ROOT/scripts/lib" \
  "$RUNNER_ROOT/apps/web/node_modules/.bin" \
  "$RUNNER_ROOT/packages/shared" \
  "$FAKE_BIN"
cp "$ROOT/scripts/test/mobile.sh" "$RUNNER_ROOT/scripts/test/mobile.sh"
cp "$ROOT/scripts/lib/e2e-tiers.sh" "$RUNNER_ROOT/scripts/lib/e2e-tiers.sh"
cp "$ROOT/scripts/lib/smoke-common.sh" "$RUNNER_ROOT/scripts/lib/smoke-common.sh"

cat >"$TEST_ROOT/fake-http-server.py" <<'PY'
import http.server
import sys


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"export {};\n" if self.path == "/src/app.tsx" else b"ok\n"
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY

cat >"$FAKE_BIN/adb" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_ADB_LOG"
if [[ -n "${FAKE_ADB_FAIL_MATCH:-}" && "$*" == *"$FAKE_ADB_FAIL_MATCH"* ]]; then
  exit 9
fi
case "$*" in
  "get-state") echo "device" ;;
  "devices")
    printf 'List of devices attached\nemulator-5570\tdevice\n'
    ;;
esac
if [[ "$*" == *"shell am start"* ]]; then
  touch "$FAKE_CASE_DIR/chrome-started"
fi
exit 0
SH

cat >"$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in
    http://* | https://*) url="$arg" ;;
  esac
done
case "$url" in
  "http://localhost:${TIER_MOBILE_CDP_PORT}/json/version")
    if [[ "${FAKE_CDP_COLD_START:-0}" == "1" && ! -f "$FAKE_CASE_DIR/chrome-started" ]]; then
      exit 7
    fi
    printf '{"Browser":"Chrome"}\n'
    exit 0
    ;;
  "http://localhost:${TIER_MOBILE_CDP_PORT}/json/new"*)
    printf '{"id":"new-page"}\n'
    exit 0
    ;;
  "http://localhost:${TIER_MOBILE_CDP_PORT}/json")
    printf '[{"id":"new-page","type":"page"}]\n'
    exit 0
    ;;
  "http://localhost:${TIER_MOBILE_CDP_PORT}/json/activate/"* | \
    "http://localhost:${TIER_MOBILE_CDP_PORT}/json/close/"*)
    printf '{}\n'
    exit 0
    ;;
esac
exec "$REAL_CURL_BIN" "$@"
SH

cat >"$FAKE_BIN/pnpm" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_PNPM_LOG"
if [[ " $* " == *" run build "* ]]; then
  if [[ "${FAKE_PNPM_RACE_LISTENER:-0}" == "1" ]]; then
    "$REAL_PYTHON_BIN" "$FAKE_SERVER_SCRIPT" "$TIER_MOBILE_VITE_PORT" \
      >"$FAKE_CASE_DIR/race-listener.log" 2>&1 &
    race_pid="$!"
    printf '%s\n' "$race_pid" >"$FAKE_CASE_DIR/race-listener.pid"
    printf '%s\n' "$race_pid" >>"$FAKE_EXTERNAL_PID_FILE"
    for _ in $(seq 1 100); do
      "$REAL_LSOF_BIN" -nP -iTCP:"$TIER_MOBILE_VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
      sleep 0.01
    done
  fi
  exit 0
fi
if [[ " $* " == *" exec vite "* ]]; then
  [[ " $* " == *" --strictPort "* ]] || exit 71
  port=""
  previous=""
  for arg in "$@"; do
    if [[ "$previous" == "--port" ]]; then
      port="$arg"
      break
    fi
    previous="$arg"
  done
  [[ -n "$port" ]] || exit 72
  exec "$REAL_PYTHON_BIN" "$FAKE_SERVER_SCRIPT" "$port"
fi
exit 0
SH

cat >"$FAKE_BIN/rmdir" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_RMDIR_LOG"
exec "$REAL_RMDIR_BIN" "$@"
SH

cat >"$FAKE_BIN/shlock" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_SHLOCK_LOG"
exit 99
SH

cat >"$RUNNER_ROOT/apps/web/node_modules/.bin/playwright" <<'SH'
#!/usr/bin/env bash
output_dir=""
spec=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "--output" ]]; then
    output_dir="$arg"
  fi
  previous="$arg"
  spec="$arg"
done
[[ " $* " == *" --workers=1 "* ]] || exit 81
[[ " $* " == *" --retries=0 "* ]] || exit 82
[[ " $* " == *" --max-failures=1 "* ]] || exit 83
[[ -n "$output_dir" ]] || exit 84
mkdir -p "$output_dir"
printf '%s|%s\n' "$spec" "$output_dir" >>"$FAKE_PLAYWRIGHT_LOG"
touch "$output_dir/invoked"
if [[ -n "${FAKE_PLAYWRIGHT_POISON_LOCK:-}" ]]; then
  touch "$TEST_MOBILE_LOCK_ROOT/$FAKE_PLAYWRIGHT_POISON_LOCK/poison"
fi
if [[ -n "${FAKE_PLAYWRIGHT_FAIL_SPEC:-}" && "$spec" == *"$FAKE_PLAYWRIGHT_FAIL_SPEC"* ]]; then
  exit 7
fi
exit 0
SH

chmod +x \
  "$FAKE_BIN/adb" \
  "$FAKE_BIN/curl" \
  "$FAKE_BIN/pnpm" \
  "$FAKE_BIN/rmdir" \
  "$FAKE_BIN/shlock" \
  "$RUNNER_ROOT/apps/web/node_modules/.bin/playwright"

cat >"$TEST_ROOT/bash-env" <<'SH'
pnpm() {
  "$MOBILE_RUNNER_TEST_FAKE_BIN/pnpm" "$@"
}
export -f pnpm
SH

allocate_ports() {
  "$REAL_PYTHON_BIN" - <<'PY'
import socket

sockets = []
ports = []
for _ in range(3):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
    ports.append(sock.getsockname()[1])
print(*ports)
for sock in sockets:
    sock.close()
PY
}

CASE_DIR=""
VITE_PORT=""
RELAY_PORT=""
CDP_PORT=""
RUN_RC=0
CASE_FAIL_SPEC=""
CASE_POISON_LOCK=""
CASE_ADB_FAIL_MATCH=""
CASE_RACE_LISTENER=0
CASE_FAIL_FAST=1
CASE_COLD_START=0

prepare_case() {
  local name="$1"
  CASE_DIR="$TEST_ROOT/cases/$name"
  mkdir -p "$CASE_DIR/tmp" "$CASE_DIR/locks" "$CASE_DIR/artifacts"
  read -r VITE_PORT RELAY_PORT CDP_PORT < <(allocate_ports)
  CASE_FAIL_SPEC=""
  CASE_POISON_LOCK=""
  CASE_ADB_FAIL_MATCH=""
  CASE_RACE_LISTENER=0
  CASE_FAIL_FAST=1
  CASE_COLD_START=0
  : >"$CASE_DIR/adb.log"
  : >"$CASE_DIR/pnpm.log"
  : >"$CASE_DIR/rmdir.log"
  : >"$CASE_DIR/shlock.log"
}

run_mobile() {
  set +e
  env \
    PATH="$FAKE_BIN:$SYSTEM_PATH" \
    BASH_ENV="$TEST_ROOT/bash-env" \
    MOBILE_RUNNER_TEST_FAKE_BIN="$FAKE_BIN" \
    TMPDIR="$CASE_DIR/tmp" \
    ANDROID_SERIAL="emulator-5570" \
    TEST_MOBILE_REQUIRE_EMULATOR=1 \
    TEST_MOBILE_ARTIFACT_DIR="$CASE_DIR/artifacts" \
    TEST_MOBILE_LOCK_ROOT="$CASE_DIR/locks" \
    TEST_MOBILE_FAIL_FAST="$CASE_FAIL_FAST" \
    TIER_MOBILE_VITE_PORT="$VITE_PORT" \
    TIER_MOBILE_RELAY_PORT="$RELAY_PORT" \
    TIER_MOBILE_CDP_PORT="$CDP_PORT" \
    REAL_CURL_BIN="$REAL_CURL_BIN" \
    REAL_LSOF_BIN="$REAL_LSOF_BIN" \
    REAL_PYTHON_BIN="$REAL_PYTHON_BIN" \
    REAL_RMDIR_BIN="$REAL_RMDIR_BIN" \
    FAKE_SERVER_SCRIPT="$TEST_ROOT/fake-http-server.py" \
    FAKE_CASE_DIR="$CASE_DIR" \
    FAKE_EXTERNAL_PID_FILE="$EXTERNAL_PID_FILE" \
    FAKE_ADB_LOG="$CASE_DIR/adb.log" \
    FAKE_PNPM_LOG="$CASE_DIR/pnpm.log" \
    FAKE_RMDIR_LOG="$CASE_DIR/rmdir.log" \
    FAKE_SHLOCK_LOG="$CASE_DIR/shlock.log" \
    FAKE_PLAYWRIGHT_LOG="$CASE_DIR/playwright.log" \
    FAKE_ADB_FAIL_MATCH="$CASE_ADB_FAIL_MATCH" \
    FAKE_CDP_COLD_START="$CASE_COLD_START" \
    FAKE_PNPM_RACE_LISTENER="$CASE_RACE_LISTENER" \
    FAKE_PLAYWRIGHT_FAIL_SPEC="$CASE_FAIL_SPEC" \
    FAKE_PLAYWRIGHT_POISON_LOCK="$CASE_POISON_LOCK" \
    bash "$RUNNER_ROOT/scripts/test/mobile.sh" "$@" \
    >"$CASE_DIR/output.log" 2>&1
  RUN_RC="$?"
  set -e
}

start_external_server() {
  local port="$1"
  local log_file="$2"
  local pid
  "$REAL_PYTHON_BIN" "$TEST_ROOT/fake-http-server.py" "$port" >"$log_file" 2>&1 &
  pid="$!"
  printf '%s\n' "$pid" >>"$EXTERNAL_PID_FILE"
  for _ in $(seq 1 100); do
    if "$REAL_LSOF_BIN" -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$pid"
      return
    fi
    sleep 0.01
  done
  fail "external listener did not start on $port"
}

# Happy path: one canonical lock namespace, strict Vite ownership, reverse release,
# and a dedicated Playwright output directory.
prepare_case happy
run_mobile e2e/mobile/one.spec.ts
assert_eq 0 "$RUN_RC" "happy runner exit"
assert_contains "$CASE_DIR/pnpm.log" "--strictPort"
assert_contains "$CASE_DIR/playwright.log" "e2e/mobile/one.spec.ts|$CASE_DIR/artifacts/playwright/one"
[[ -f "$CASE_DIR/artifacts/playwright/one/invoked" ]] || fail "per-spec artifact missing"
assert_eq "" "$(cat "$CASE_DIR/shlock.log")" "canonical lock must not call shlock"
expected_release_order="$(printf '%s\n' \
  "$CASE_DIR/locks/tcp-${RELAY_PORT}.lock" \
  "$CASE_DIR/locks/tcp-${VITE_PORT}.lock" \
  "$CASE_DIR/locks/tcp-${CDP_PORT}.lock" \
  "$CASE_DIR/locks/device-emulator-5570.lock")"
assert_eq "$expected_release_order" "$(cat "$CASE_DIR/rmdir.log")" "lock release order"
if "$REAL_LSOF_BIN" -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "owned Vite listener survived cleanup"
fi

# A live canonical lock fails before any service mutation, even though shlock is
# deliberately present in PATH.
prepare_case lock-contention
mkdir "$CASE_DIR/locks/device-emulator-5570.lock"
printf '%s\n' "$$" >"$CASE_DIR/locks/device-emulator-5570.lock/pid"
run_mobile e2e/mobile/one.spec.ts
assert_eq 1 "$RUN_RC" "contended runner exit"
assert_contains "$CASE_DIR/output.log" "already locked by pid $$"
assert_eq "" "$(cat "$CASE_DIR/pnpm.log")" "contended runner must not start Vite"
assert_eq "" "$(cat "$CASE_DIR/shlock.log")" "contended runner must use canonical mkdir lock"
rm -rf "$CASE_DIR/locks/device-emulator-5570.lock"

# An existing Relay is rejected before Vite/Chrome start and is never killed.
prepare_case relay-listener
relay_pid="$(start_external_server "$RELAY_PORT" "$CASE_DIR/relay-listener.log")"
run_mobile e2e/mobile/one.spec.ts
assert_eq 2 "$RUN_RC" "Relay listener isolation exit"
assert_contains "$CASE_DIR/output.log" "first Android navigation must not connect to an unrelated Relay"
kill -0 "$relay_pid" 2>/dev/null || fail "runner killed unrelated Relay listener"
assert_eq "" "$(cat "$CASE_DIR/pnpm.log")" "Relay collision must stop before Vite"
kill "$relay_pid" 2>/dev/null || true
wait "$relay_pid" 2>/dev/null || true

# Reproduce the preflight-to-spawn race. A foreign listener wins during the shared
# build; ownership validation fails, and cleanup leaves that listener untouched.
prepare_case vite-owner-race
CASE_RACE_LISTENER=1
run_mobile e2e/mobile/one.spec.ts
assert_eq 1 "$RUN_RC" "Vite ownership race exit"
grep -E 'unrelated pid|exited before ownership validation' "$CASE_DIR/output.log" >/dev/null || \
  fail "Vite ownership race was not diagnosed"
race_pid="$(cat "$CASE_DIR/race-listener.pid")"
kill -0 "$race_pid" 2>/dev/null || fail "runner killed unrelated Vite-port listener"
assert_contains "$CASE_DIR/pnpm.log" "--strictPort"
kill "$race_pid" 2>/dev/null || true
wait "$race_pid" 2>/dev/null || true

# Required reset commands must fail the reset stage explicitly even though the
# function is invoked under `if ! reset_chrome` (where Bash disables errexit).
prepare_case reset-required-adb
CASE_ADB_FAIL_MATCH="settings put system accelerometer_rotation"
run_mobile e2e/mobile/one.spec.ts
assert_eq 1 "$RUN_RC" "required adb reset exit"
assert_contains "$CASE_DIR/output.log" "failed to disable Android auto-rotation"
assert_contains "$CASE_DIR/artifacts/mobile-timing.tsv" $'reset-failed'
[[ ! -f "$CASE_DIR/playwright.log" ]] || fail "Playwright ran after required reset failure"

# Cold-start teardown is also mandatory. A stale CDP forward that cannot be
# removed must fail reset instead of being hidden by a later Chrome start.
prepare_case cold-forward-remove
CASE_COLD_START=1
CASE_ADB_FAIL_MATCH="forward --remove tcp:$CDP_PORT"
run_mobile e2e/mobile/one.spec.ts
assert_eq 1 "$RUN_RC" "cold forward removal exit"
assert_contains "$CASE_DIR/output.log" "failed to remove the stale Chrome DevTools forward"
assert_contains "$CASE_DIR/artifacts/mobile-timing.tsv" $'reset-failed'
[[ ! -f "$CASE_DIR/playwright.log" ]] || fail "Playwright ran after stale forward removal failure"

# A successful spec followed by a cleanup failure must not return success.
prepare_case cleanup-failure
CASE_POISON_LOCK="tcp-${RELAY_PORT}.lock"
run_mobile e2e/mobile/one.spec.ts
assert_eq 1 "$RUN_RC" "cleanup failure propagation"
assert_contains "$CASE_DIR/output.log" "failed to release mobile test lock"
[[ -d "$CASE_DIR/locks/$CASE_POISON_LOCK" ]] || fail "poisoned lock should remain fail-closed"
rm -rf "$CASE_DIR/locks/$CASE_POISON_LOCK"

# Default global fail-fast stops after the first failing spec and keeps its output.
prepare_case fail-fast
CASE_FAIL_SPEC="first.spec.ts"
run_mobile e2e/mobile/first.spec.ts e2e/mobile/second.spec.ts
assert_eq 7 "$RUN_RC" "default fail-fast exit"
assert_contains "$CASE_DIR/output.log" "stopping after first failed spec"
assert_contains "$CASE_DIR/playwright.log" "first.spec.ts|$CASE_DIR/artifacts/playwright/first"
assert_not_contains "$CASE_DIR/playwright.log" "second.spec.ts"
[[ -f "$CASE_DIR/artifacts/playwright/first/invoked" ]] || fail "first failure artifact missing"
[[ ! -d "$CASE_DIR/artifacts/playwright/second" ]] || fail "second spec ran despite fail-fast"

# Diagnostic opt-out continues, but retains the failure exit and separates outputs.
prepare_case diagnostic-continue
CASE_FAIL_FAST=0
CASE_FAIL_SPEC="first.spec.ts"
run_mobile e2e/mobile/first.spec.ts e2e/mobile/second.spec.ts
assert_eq 7 "$RUN_RC" "diagnostic continue exit"
assert_contains "$CASE_DIR/playwright.log" "first.spec.ts|$CASE_DIR/artifacts/playwright/first"
assert_contains "$CASE_DIR/playwright.log" "second.spec.ts|$CASE_DIR/artifacts/playwright/second"
[[ -f "$CASE_DIR/artifacts/playwright/first/invoked" ]] || fail "first diagnostic artifact missing"
[[ -f "$CASE_DIR/artifacts/playwright/second/invoked" ]] || fail "second diagnostic artifact missing"

echo "mobile runner behavior test passed"
