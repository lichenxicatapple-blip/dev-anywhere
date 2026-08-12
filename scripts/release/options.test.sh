#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

release_script="$(cat scripts/release/release.sh)"
restart_script="$(cat scripts/dev/restart.sh)"
chaos_script="$(cat scripts/dev/chaos.sh)"

grep -q 'lsof -nP -iTCP:"\$port" -sTCP:LISTEN' <<<"$restart_script"
grep -q 'lsof -nP -iTCP:"\$1" -sTCP:LISTEN' <<<"$chaos_script"
if grep -q 'lsof -i ":' <<<"$restart_script$chaos_script"; then
  echo "dev service probes must use the portable -iTCP:<port> form" >&2
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

release_please_workflow="$(cat .github/workflows/release-please.yml)"
grep -q 'verify-chaos:' <<<"$release_please_workflow"
grep -q -- '- verify-chaos' <<<"$release_please_workflow"
grep -q 'RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1 pnpm release:deep' <<<"$release_please_workflow"
grep -q 'Upload Chaos service logs' <<<"$release_please_workflow"
grep -q 'process-chaos-service-logs-' <<<"$release_please_workflow"
grep -q 'verify-android:' <<<"$release_please_workflow"
grep -q -- '- verify-android' <<<"$release_please_workflow"
grep -q 'TEST_MOBILE_REQUIRE_EMULATOR=1 pnpm test:mobile' <<<"$release_please_workflow"
publish_dependencies="$(sed -n '/^  publish:/,/^    runs-on:\|^    uses:/p' <<<"$release_please_workflow")"
grep -q -- '- verify' <<<"$publish_dependencies"
grep -q -- '- verify-chaos' <<<"$publish_dependencies"
grep -q -- '- verify-android' <<<"$publish_dependencies"
grep -q -- '- release-please' <<<"$publish_dependencies"
if grep -q 'TEST_MOBILE_PARALLEL_WORKERS' <<<"$release_please_workflow"; then
  echo "release workflow must use the intrinsically serial test:mobile entrypoint" >&2
  exit 1
fi

if RELEASE_DEEP_SCOPE=invalid RELEASE_DEEP_SKIP_FAST=1 bash scripts/release/deep.sh >/dev/null 2>&1; then
  echo "deep release validation must reject an invalid scope" >&2
  exit 1
fi

echo "release options test passed"
