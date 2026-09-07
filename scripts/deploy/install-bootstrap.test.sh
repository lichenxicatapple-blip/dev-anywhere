#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASH_BIN="${BASH:-/bin/bash}"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-bootstrap-test.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin"

cat > "$TEST_DIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --proto|--proto-redir|--connect-timeout|--max-time|-H) shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> "$TEST_CASE_DIR/requests"
if [[ "$url" == */commits/main ]]; then
  [[ "$TEST_SCENARIO" != api-failure ]] || exit 22
  if [[ "$TEST_SCENARIO" == invalid-revision ]]; then
    printf '%s\n' '<html>unavailable</html>'
  else
    printf '%040d\n' 1
  fi
  exit 0
fi
[[ "$url" == *'/0000000000000000000000000000000000000001/scripts/'* ]] || exit 91
case "$url" in
  */lib/install-relay-render.sh)
    [[ "$TEST_SCENARIO" != helper-failure ]] || exit 22
    if [[ "$TEST_SCENARIO" == invalid-helper ]]; then
      printf '%s\n' 'this is not valid bash (' > "$output"
    else
      printf '%s\n' 'test_helper() { printf "helper loaded\n"; }' > "$output"
    fi
    ;;
  */deploy/install-relay.sh)
    [[ "$TEST_SCENARIO" != installer-failure ]] || exit 22
    if [[ "$TEST_SCENARIO" == empty-installer ]]; then
      : > "$output"
    elif [[ "$TEST_SCENARIO" == invalid-installer ]]; then
      printf '%s\n' 'printf executed > "$TEST_CASE_DIR/executed"' 'if' > "$output"
    else
      cat > "$output" <<'PAYLOAD'
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib/install-relay-render.sh"
test_helper > "$TEST_CASE_DIR/helper-result"
printf '%s\0' "$@" > "$TEST_CASE_DIR/args"
printf '%s\0' "${IMAGE_TAG:-}" "${REGISTRY_BASE:-}" "${DEV_ANYWHERE_RELAY_PORT:-}" > "$TEST_CASE_DIR/env"
printf '%s\n' "$0" > "$TEST_CASE_DIR/executed"
exit "${TEST_INSTALLER_EXIT:-0}"
PAYLOAD
    fi
    ;;
  *) exit 92 ;;
esac
STUB
chmod +x "$TEST_DIR/bin/curl"

run_case() {
  TEST_CASE_DIR="$TEST_DIR/$1"
  TEST_SCENARIO="$2"
  shift 2
  mkdir -p "$TEST_CASE_DIR/tmp"
  TEST_STATUS=0
  PATH="$TEST_DIR/bin:$PATH" TMPDIR="$TEST_CASE_DIR/tmp" \
    TEST_CASE_DIR="$TEST_CASE_DIR" TEST_SCENARIO="$TEST_SCENARIO" \
    IMAGE_TAG='0.9.6' REGISTRY_BASE='registry.example/team' DEV_ANYWHERE_RELAY_PORT=3199 \
    "$BASH_BIN" "$ROOT/install.sh" "$@" > "$TEST_CASE_DIR/stdout" 2> "$TEST_CASE_DIR/stderr" || TEST_STATUS=$?
  [[ -z "$(ls -A "$TEST_CASE_DIR/tmp")" ]] || { echo 'temporary download directory leaked' >&2; exit 1; }
}

assert_status() {
  if [[ "$TEST_STATUS" != "$1" ]]; then
    cat "$TEST_CASE_DIR/stderr" >&2
    echo "unexpected exit status: $TEST_STATUS (expected $1)" >&2
    exit 1
  fi
}

run_case direct success relay.example.com
assert_status 0
printf '%s\0' relay.example.com > "$TEST_CASE_DIR/expected"
cmp "$TEST_CASE_DIR/expected" "$TEST_CASE_DIR/args"
printf '%s\0' 0.9.6 registry.example/team 3199 > "$TEST_CASE_DIR/expected"
cmp "$TEST_CASE_DIR/expected" "$TEST_CASE_DIR/env"
[[ "$(wc -l < "$TEST_CASE_DIR/requests" | tr -d ' ')" == 3 ]]

run_case remote success --ssh 'user@vps' '203.0.113.10'
assert_status 0
printf '%s\0' --ssh user@vps 203.0.113.10 > "$TEST_CASE_DIR/expected"
cmp "$TEST_CASE_DIR/expected" "$TEST_CASE_DIR/args"

for scenario in api-failure helper-failure installer-failure; do
  run_case "$scenario" "$scenario" relay.example.com
  assert_status 22
  [[ ! -e "$TEST_CASE_DIR/executed" ]]
done
for scenario in invalid-revision empty-installer invalid-helper invalid-installer; do
  run_case "$scenario" "$scenario" relay.example.com
  [[ "$TEST_STATUS" != 0 && ! -e "$TEST_CASE_DIR/executed" ]]
done

TEST_INSTALLER_EXIT=37
export TEST_INSTALLER_EXIT
run_case remote-failure success --ssh user@vps relay.example.com
assert_status 37
unset TEST_INSTALLER_EXIT

run_case help success --help
assert_status 0
[[ ! -e "$TEST_CASE_DIR/requests" ]]
run_case missing success
assert_status 2
[[ ! -e "$TEST_CASE_DIR/requests" ]]
run_case missing-remote success --ssh user@vps
assert_status 2
[[ ! -e "$TEST_CASE_DIR/requests" ]]
run_case option-target success --ssh '-oProxyCommand=bad' relay.example.com
assert_status 2
[[ ! -e "$TEST_CASE_DIR/requests" ]]

# Use the same stdin form as curl | bash, not only a file invocation.
TEST_CASE_DIR="$TEST_DIR/pipe"
mkdir -p "$TEST_CASE_DIR/tmp"
PATH="$TEST_DIR/bin:$PATH" TMPDIR="$TEST_CASE_DIR/tmp" \
  TEST_CASE_DIR="$TEST_CASE_DIR" TEST_SCENARIO=success \
  "$BASH_BIN" -s -- --ssh user@vps relay.example.com < "$ROOT/install.sh"
[[ -s "$TEST_CASE_DIR/executed" && -z "$(ls -A "$TEST_CASE_DIR/tmp")" ]]

echo 'install bootstrap tests passed'
