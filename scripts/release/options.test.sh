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
grep -q "EMERGENCY RELEASE: skipping release:smoke" <<<"$release_script"
grep -q "pnpm release:check" <<<"$release_script"
grep -q "Run mandatory process Chaos release gate" <<<"$release_script"
grep -q "RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep" <<<"$release_script"
grep -q "Run mandatory Android Chrome release gate" <<<"$release_script"
grep -q "RELEASE_DEEP_SCOPE=mobile RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep" <<<"$release_script"

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
grep -q 'ws://localhost:3100' <<<"$main_workflow"
grep -q 'group: main-verification-' <<<"$main_workflow"
grep -q 'cancel-in-progress: true' <<<"$main_workflow"
grep -q 'path: ~/.dev-anywhere' <<<"$main_workflow"
grep -q 'include-hidden-files: true' <<<"$main_workflow"
if grep -q 'service_status | grep -q' <<<"$chaos_script"; then
  echo "Chaos status probes must not use grep -q under pipefail" >&2
  exit 1
fi
grep -q 'Upload Chaos service logs' <<<"$main_workflow"
grep -q 'process-chaos-service-logs-' <<<"$main_workflow"
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

echo "release options test passed"
