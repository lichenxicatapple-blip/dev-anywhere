#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="$ROOT/scripts/deploy/install-relay.sh"
BASH_BIN="${BASH:-/bin/bash}"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-relay-ssh.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STUB_DIR="$TEST_DIR/bin"
mkdir -p "$STUB_DIR"

fail() {
  echo "FAIL: $*" >&2
  if [ -f "${TEST_CASE_DIR:-}/stderr" ]; then
    cat "$TEST_CASE_DIR/stderr" >&2
  fi
  exit 1
}

cat > "$STUB_DIR/ssh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\0' "$@" > "$TEST_CASE_DIR/ssh-args"
[ "$#" -eq 4 ] && [ "$1" = '-T' ] && [ "$2" = '--' ] || exit 90
if [ "$TEST_SSH_EXIT" -ne 0 ]; then
  cat >/dev/null
  exit "$TEST_SSH_EXIT"
fi
printf '%s' "$4" > "$TEST_CASE_DIR/remote-command"
# A real SSH connection does not inherit these local environment variables.
unset REGISTRY_BASE IMAGE_TAG DEV_ANYWHERE_RELAY_PORT
cd "$TEST_CASE_DIR/remote"
/bin/sh -c "$4"
EOF

cat > "$STUB_DIR/id" <<'EOF'
#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = '-u' ] || exit 91
printf '%s\n' "$TEST_UID"
EOF

cat > "$STUB_DIR/sudo" <<'EOF'
#!/bin/sh
set -eu
printf '%s\0' "$@" > "$TEST_CASE_DIR/sudo-args"
[ "$1" = '-n' ] || exit 92
shift
if [ "$TEST_SUDO_EXIT" -ne 0 ]; then
  cat >/dev/null
  exit "$TEST_SUDO_EXIT"
fi
"$@"
EOF

cat > "$STUB_DIR/bash" <<'EOF'
#!/bin/sh
set -eu
printf '%s\0' "$@" > "$TEST_CASE_DIR/bash-args"
printf '%s\0' "${REGISTRY_BASE-UNSET}" "${IMAGE_TAG-UNSET}" "${DEV_ANYWHERE_RELAY_PORT-UNSET}" > "$TEST_CASE_DIR/bash-env"
cat > "$TEST_CASE_DIR/payload"
exit "$TEST_REMOTE_EXIT"
EOF
chmod +x "$STUB_DIR/ssh" "$STUB_DIR/id" "$STUB_DIR/sudo" "$STUB_DIR/bash"

new_case() {
  TEST_CASE_DIR="$TEST_DIR/$1"
  mkdir -p "$TEST_CASE_DIR/remote"
  TEST_UID=0
  TEST_SSH_EXIT=0
  TEST_SUDO_EXIT=0
  TEST_REMOTE_EXIT=0
  TEST_REGISTRY=""
  TEST_IMAGE_TAG=""
  TEST_RELAY_PORT=""
}

run_install() {
  STATUS=0
  PATH="$STUB_DIR:$PATH" \
    TEST_CASE_DIR="$TEST_CASE_DIR" \
    TEST_UID="$TEST_UID" \
    TEST_SSH_EXIT="$TEST_SSH_EXIT" \
    TEST_SUDO_EXIT="$TEST_SUDO_EXIT" \
    TEST_REMOTE_EXIT="$TEST_REMOTE_EXIT" \
    REGISTRY_BASE="$TEST_REGISTRY" \
    IMAGE_TAG="$TEST_IMAGE_TAG" \
    DEV_ANYWHERE_RELAY_PORT="$TEST_RELAY_PORT" \
    "$BASH_BIN" "$INSTALLER" --ssh "$@" \
    > "$TEST_CASE_DIR/stdout" 2> "$TEST_CASE_DIR/stderr" || STATUS=$?
}

assert_values() {
  local actual="$1"
  shift
  printf '%s\0' "$@" > "$TEST_CASE_DIR/expected-values"
  cmp -s "$TEST_CASE_DIR/expected-values" "$actual" || fail "unexpected values in ${actual##*/}"
}

assert_payload() {
  {
    cat "$ROOT/scripts/lib/install-relay-render.sh"
    printf '\n'
    cat "$INSTALLER"
  } > "$TEST_CASE_DIR/expected-payload"
  cmp -s "$TEST_CASE_DIR/expected-payload" "$TEST_CASE_DIR/payload" ||
    fail "remote stdin must contain both helpers and installer without a checkout"
}

new_case root_quoted_arguments
TEST_REGISTRY="registry.example/owner's images"
TEST_IMAGE_TAG="release'; touch '$TEST_CASE_DIR/injected-env'; #"
TEST_RELAY_PORT=$'3100\nextra line'
PUBLIC_HOST="relay'; touch '$TEST_CASE_DIR/injected-host'; #"
PROXY_TOKEN="proxy' token; \$(touch '$TEST_CASE_DIR/injected-token')"
CLIENT_TOKEN=$'client token\nwith a newline and \\backslash'
run_install "root@vps.example" "$PUBLIC_HOST" "$PROXY_TOKEN" "$CLIENT_TOKEN"
[ "$STATUS" -eq 0 ] || fail "root deployment transport failed with $STATUS"
assert_values "$TEST_CASE_DIR/bash-args" '-s' '--' "$PUBLIC_HOST" "$PROXY_TOKEN" "$CLIENT_TOKEN"
assert_values "$TEST_CASE_DIR/bash-env" "$TEST_REGISTRY" "$TEST_IMAGE_TAG" "$TEST_RELAY_PORT"
assert_values "$TEST_CASE_DIR/ssh-args" '-T' '--' 'root@vps.example' "$(< "$TEST_CASE_DIR/remote-command")"
[ ! -e "$TEST_CASE_DIR/sudo-args" ] || fail "root must not invoke sudo"
for marker in injected-env injected-host injected-token; do
  [ ! -e "$TEST_CASE_DIR/$marker" ] || fail "remote input executed shell commands"
done
assert_payload

new_case non_root_empty_tokens
TEST_UID=1000
run_install "deploy@vps.example" "203.0.113.10"
[ "$STATUS" -eq 0 ] || fail "non-root deployment transport failed with $STATUS"
assert_values "$TEST_CASE_DIR/bash-args" '-s' '--' '203.0.113.10' '' ''
assert_values "$TEST_CASE_DIR/bash-env" '' '' ''
assert_values "$TEST_CASE_DIR/sudo-args" '-n' 'env' 'REGISTRY_BASE=' 'IMAGE_TAG=' 'DEV_ANYWHERE_RELAY_PORT=' 'bash' '-s' '--' '203.0.113.10' '' ''
assert_payload

new_case remote_failure
TEST_REMOTE_EXIT=37
run_install "root@vps.example" "relay.example.com"
[ "$STATUS" -eq 37 ] || fail "remote exit status was not preserved: $STATUS"

new_case ssh_failure
TEST_SSH_EXIT=42
run_install "root@vps.example" "relay.example.com"
[ "$STATUS" -eq 42 ] || fail "SSH exit status was not preserved: $STATUS"
[ ! -e "$TEST_CASE_DIR/bash-args" ] || fail "installer ran after SSH failed"

new_case sudo_failure
TEST_UID=1000
TEST_SUDO_EXIT=43
run_install "deploy@vps.example" "relay.example.com"
[ "$STATUS" -eq 43 ] || fail "sudo exit status was not preserved: $STATUS"
[ ! -e "$TEST_CASE_DIR/bash-args" ] || fail "installer ran after sudo failed"

new_case ssh_option_rejected
run_install '-oProxyCommand=unexpected-command' 'relay.example.com'
[ "$STATUS" -ne 0 ] || fail "SSH option was accepted as a host"
[ ! -e "$TEST_CASE_DIR/ssh-args" ] || fail "SSH ran with an option-shaped host"

echo "install-relay SSH tests passed"
