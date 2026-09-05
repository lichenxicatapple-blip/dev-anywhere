#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

release_script="$(cat scripts/release/release.sh)"
restart_script="$(cat scripts/dev/restart.sh)"
chaos_script="$(cat scripts/dev/chaos.sh)"

grep -q '127.0.0.1:\$RELAY_PORT/api/status' <<<"$restart_script"
grep -q 'relay HTTP status responds' <<<"$chaos_script"
grep -q 'relay HTTP status is down' <<<"$chaos_script"
if grep -q 'wait_until .*listener' <<<"$chaos_script"; then
  echo "Chaos health gates must use HTTP readiness instead of lsof listener probes" >&2
  exit 1
fi

grep -q -- "--emergency" <<<"$release_script"
grep -q "RELEASE_EMERGENCY" <<<"$release_script"
grep -q "EMERGENCY RELEASE: skipping all tests, runtime smoke, Chaos and Android" <<<"$release_script"
grep -q "pnpm release:check" <<<"$release_script"
grep -q 'pnpm release:check --static-only' <<<"$release_script"
grep -Fq 'git commit -m "release: ${TAG}" -m "[skip tests]"' <<<"$release_script"
grep -q "Run mandatory process Chaos release gate" <<<"$release_script"
grep -q "RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep" <<<"$release_script"
grep -q "Run mandatory Android Chrome release gate" <<<"$release_script"
grep -q "RELEASE_DEEP_SCOPE=mobile RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep" <<<"$release_script"

emergency_checks="$(sed -n '/^if \[\[ "\$EMERGENCY" == "1" \]\]; then$/,/^fi$/p' scripts/release/release.sh | sed -n '/EMERGENCY RELEASE:/,/^else$/p')"
grep -q 'pnpm format:check' <<<"$emergency_checks"
grep -q 'pnpm lint' <<<"$emergency_checks"
grep -q 'pnpm typecheck' <<<"$emergency_checks"
grep -q 'pnpm release:check --static-only' <<<"$emergency_checks"
[[ "$emergency_checks" == *"pnpm release:check --static-only"*"pnpm typecheck"* ]]
if grep -qE '^[[:space:]]*(pnpm (test|release:smoke|release:deep)|RELEASE_DEEP_SCOPE=)' <<<"$emergency_checks"; then
  echo "emergency release must not run test, smoke, Chaos or Android gates" >&2
  exit 1
fi

check_script="$(cat scripts/release/check.sh)"
grep -q -- '--static-only)' <<<"$check_script"
grep -q 'Check package version consistency' <<<"$check_script"
grep -q '^pnpm build$' <<<"$check_script"
grep -q 'npm pack --dry-run --json --ignore-scripts' <<<"$check_script"
grep -q 'release static package checks passed (tests and runtime smoke skipped)' <<<"$check_script"
test_checks="$(sed -n '/^if \[\[ "\$STATIC_ONLY" != "1" \]\]; then$/,/^fi$/p' scripts/release/check.sh)"
grep -q 'bash scripts/deploy/install-relay-render.test.sh' <<<"$test_checks"
grep -q 'bash scripts/release/options.test.sh' <<<"$test_checks"
grep -q 'node scripts/release/config.test.mjs' <<<"$test_checks"

smoke_script="$(cat scripts/release/smoke.sh)"
deep_script="$(cat scripts/release/deep.sh)"

grep -q 'run_timed_stage "unit"' <<<"$smoke_script"
grep -q 'run_timed_stage "layout-e2e"' <<<"$smoke_script"
grep -q 'run_timed_stage "desktop-e2e"' <<<"$smoke_script"
if grep -qE 'dev:chaos|test:mobile|real-clipboard-image' <<<"$smoke_script"; then
  echo "fast release smoke must not include environment-heavy deep checks" >&2
  exit 1
fi
grep -q 'run_timed_stage "real-file-chain"' <<<"$deep_script"
grep -q 'run_timed_stage "process-chaos"' <<<"$deep_script"
grep -q 'run_timed_stage "android-e2e"' <<<"$deep_script"
grep -q 'RELEASE_DEEP_SCOPE' <<<"$deep_script"
grep -q 'mktemp -d "$profile_root/release-e2e.XXXXXX"' <<<"$deep_script"
grep -q 'allocate_isolated_ports' <<<"$deep_script"
grep -q 'export RELAY_URL="ws://127.0.0.1:$ISOLATED_RELAY_PORT"' <<<"$deep_script"
grep -q 'export DEV_ANYWHERE_HOOK_PORT="$ISOLATED_HOOK_PORT"' <<<"$deep_script"
grep -q 'export DEV_ANYWHERE_E2E_LOG_DIR="$ISOLATED_LOG_DIR"' <<<"$deep_script"
grep -q 'DEV_ANYWHERE_E2E_OWNER_TOKEN' <<<"$deep_script"
grep -q 'export DATA_DIR="$ISOLATED_PROFILE_DIR/relay-data"' <<<"$deep_script"
grep -q -- '--ephemeral-profile-dir "$ISOLATED_PROFILE_DIR"' <<<"$deep_script"
grep -q 'MOBILE_STARTED' <<<"$deep_script"
grep -q '\[\[ -n "$ISOLATED_PROFILE_DIR" \]\] || return 0' <<<"$deep_script"
grep -q '\[\[ -n "$pids" \]\] || return 0' <<<"$deep_script"
if grep -qE -- '--profile local|--relay local|--relay-port 3100|--web-port 5173' <<<"$deep_script"; then
  echo "deep release checks must not reuse the developer's local runtime" >&2
  exit 1
fi
grep -q 'PROXY_RELAY_ARGS' <<<"$restart_script"
grep -q 'PROXY_RELAY_ARGS' <<<"$chaos_script"
grep -q 'PROXY_LOG_DIR' <<<"$chaos_script"
grep -q '.release-e2e-owner' <<<"$chaos_script"
if grep -q -- 'serve restart --relay "$DEV_RELAY"' <<<"$restart_script$chaos_script"; then
  echo "environment-backed E2E profiles must not receive a named relay argument" >&2
  exit 1
fi
relay_restart_script="$(cat scripts/dev/relay-restart.sh)"
for local_relay_script in "$restart_script" "$chaos_script" "$relay_restart_script"; do
  grep -q -- '-u RELAY_PROXY_TOKEN' <<<"$local_relay_script"
  grep -q -- '-u RELAY_CLIENT_TOKEN' <<<"$local_relay_script"
  grep -q -- '-u ALLOWED_ORIGINS' <<<"$local_relay_script"
done
grep -q 'RELEASE_MOBILE_BASE_PORT="${DEV_ANYWHERE_MOBILE_BASE_PORT:-5570}"' <<<"$deep_script"
grep -q 'RELEASE_MOBILE_SERIAL="emulator-${RELEASE_MOBILE_BASE_PORT}"' <<<"$deep_script"
grep -q 'DEV_ANYWHERE_MOBILE_BASE_PORT="$RELEASE_MOBILE_BASE_PORT"' <<<"$deep_script"
grep -q 'ANDROID_SERIAL="$RELEASE_MOBILE_SERIAL"' <<<"$deep_script"

mobile_package_scripts="$(node -e 'const p=require("./package.json"); process.stdout.write(JSON.stringify(p.scripts))')"
grep -q '"test:mobile":"bash scripts/test/mobile.sh"' <<<"$mobile_package_scripts"
grep -q '"test:mobile:parallel":"bash scripts/test/mobile-parallel.sh"' <<<"$mobile_package_scripts"
if grep -q '"test:mobile":"bash scripts/test/mobile-parallel.sh"' <<<"$mobile_package_scripts"; then
  echo "default mobile gate must never call the parallel dispatcher" >&2
  exit 1
fi

main_workflow="$(cat .github/workflows/main.yml)"
grep -q 'verify-chaos:' <<<"$main_workflow"
grep -q 'RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep' <<<"$main_workflow"
grep -q 'Configure isolated local runtime' <<<"$main_workflow"
grep -q 'profiles: {}' <<<"$main_workflow"
grep -q 'relays: {}' <<<"$main_workflow"
grep -q 'group: main-verification-' <<<"$main_workflow"
grep -q 'cancel-in-progress: true' <<<"$main_workflow"
[[ "$(grep -Fc "if: \${{ !contains(github.event.head_commit.message, '[skip tests]') }}" <<<"$main_workflow")" == "2" ]]
grep -q '~/.dev-anywhere' <<<"$main_workflow"
grep -q 'include-hidden-files: true' <<<"$main_workflow"
if grep -q 'service_status | grep -q' <<<"$chaos_script"; then
  echo "Chaos status probes must not use grep -q under pipefail" >&2
  exit 1
fi

start_proxy_serve_function="$(sed -n '/^start_proxy_serve() {$/,/^}$/p' scripts/dev/chaos.sh)"
bash -s -- "$start_proxy_serve_function" <<'EOF'
set -euo pipefail
eval "$1"
ROOT="$PWD"
proxy_serve_action() {
  printf '%s\n' '> tsx src/index.ts serve start' "$start_output"
  return "$start_exit"
}
sleep() { return 0; }
start_output='Service ready (PID 2428)'
start_exit=0
start_proxy_serve >/dev/null
[[ "$STARTED_PROXY_PID" == 2428 ]]
for start_output in 'Service started in background (PID 2428)' 'Service stopped'; do
  if start_proxy_serve >/dev/null 2>&1; then
    echo "Chaos accepted a non-ready CLI startup result" >&2
    exit 1
  fi
done
start_output='Service ready (PID 2428)'
start_exit=1
if start_proxy_serve >/dev/null 2>&1; then
  echo "Chaos ignored the CLI startup exit code" >&2
  exit 1
fi
EOF

real_backend_config="$(cat apps/web/e2e/fixtures/real-backend-config.ts)"
real_backend_specs="$(cat \
  apps/web/e2e/pc/chaos/integration/real-local-pty-chaos.spec.ts \
  apps/web/e2e/pc/chaos/integration/real-json-worker-chaos.spec.ts \
  apps/web/e2e/pc/real-clipboard-image.spec.ts \
  apps/web/e2e/pc/real-provider-approval.spec.ts)"
grep -q 'DEV_ANYWHERE_E2E_PROFILE' <<<"$real_backend_config"
grep -q 'DEV_ANYWHERE_E2E_RELAY_PORT' <<<"$real_backend_config"
grep -q 'DEV_ANYWHERE_E2E_LOG_DIR' <<<"$real_backend_config"
grep -q 'requireE2EBackendConfig' <<<"$real_backend_specs"
grep -q 'requireE2ERelayRestartConfig' <<<"$real_backend_specs"
if grep -qE 'proxyProfile = "local"|proxyRelay = "local"|relayPort = "3100"' <<<"$real_backend_specs"; then
  echo "real backend E2E specs must not fall back to the developer's local runtime" >&2
  exit 1
fi
grep -q 'Upload Chaos service logs' <<<"$main_workflow"
grep -q 'process-chaos-service-logs-' <<<"$main_workflow"
grep -q 'artifacts/release-deep' <<<"$main_workflow"
if grep -qE 'verify-android:|android-emulator-runner|pnpm test:mobile' <<<"$main_workflow"; then
  echo "GitHub main verification must not run the local Android emulator gate" >&2
  exit 1
fi
if grep -qE 'release-please|release_created|Publish release artifacts|workflows/release\.yml' <<<"$main_workflow"; then
  echo "GitHub main verification must never create or publish releases" >&2
  exit 1
fi
grep -q 'mobile_run_playwright_spec' scripts/test/mobile.sh
grep -q -- '--workers=1' scripts/test/mobile.sh
grep -q -- '--retries=0' scripts/test/mobile.sh
grep -q -- '--max-failures=1' scripts/test/mobile.sh
grep -q 'FAIL_FAST="${TEST_MOBILE_FAIL_FAST:-1}"' scripts/test/mobile.sh
grep -q 'RESET_FAIL_FAST="${TEST_MOBILE_RESET_FAIL_FAST:-$FAIL_FAST}"' scripts/test/mobile.sh
grep -q -- '--output "$output_dir"' scripts/test/mobile.sh
grep -q 'lock_path="$MOBILE_LOCK_ROOT/$safe_resource.lock"' scripts/test/mobile.sh
if grep -q 'command -v shlock\|\.lock\.d' scripts/test/mobile.sh; then
  echo "mobile resource locks must use one canonical mkdir path on every host" >&2
  exit 1
fi
grep -q 'mobile_acquire_run_lock "device-${ANDROID_SERIAL}"' scripts/test/mobile.sh
grep -q 'mobile_acquire_run_lock "tcp-${CDP_PORT}"' scripts/test/mobile.sh
grep -q 'mobile_acquire_run_lock "tcp-${TIER_MOBILE_VITE_PORT}"' scripts/test/mobile.sh
grep -q 'mobile_acquire_run_lock "tcp-${TIER_MOBILE_RELAY_PORT}"' scripts/test/mobile.sh
grep -q 'DEV_ANYWHERE_WEB_RELAY_TARGET="http://127.0.0.1:${TIER_MOBILE_RELAY_PORT}"' scripts/test/mobile.sh
grep -q -- '--strictPort' scripts/lib/smoke-common.sh
grep -q 'smoke_capture_started_vite_ownership' scripts/lib/smoke-common.sh
grep -Fq "grep -Fxq 'com.android.chrome'" scripts/test/mobile.sh
if grep -q 'adb shell ps .*|| true' scripts/test/mobile.sh; then
  echo "mobile Chrome exit checks must not count adb failures as process absence" >&2
  exit 1
fi
if grep -q 'com\\.android\\.chrome(?:' scripts/test/mobile.sh; then
  echo "mobile Chrome process checks must use a portable exact main-process match" >&2
  exit 1
fi
publish_workflow="$(cat .github/workflows/release.yml)"
grep -Fq -- '- "v*.*.*"' <<<"$publish_workflow"
grep -q 'workflow_dispatch:' <<<"$publish_workflow"
if grep -q 'workflow_call:' <<<"$publish_workflow"; then
  echo "GitHub release must only accept a pushed tag or manual recovery dispatch" >&2
  exit 1
fi

if RELEASE_DEEP_SCOPE=invalid RELEASE_DEEP_SKIP_FAST=1 bash scripts/release/deep.sh >/dev/null 2>&1; then
  echo "deep release validation must reject an invalid scope" >&2
  exit 1
fi

bash scripts/test/mobile-runner.test.sh

echo "release options test passed"
