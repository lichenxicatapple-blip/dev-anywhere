#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

release_script="$(cat scripts/release/release.sh)"

grep -q -- "--emergency" <<<"$release_script"
grep -q "RELEASE_EMERGENCY" <<<"$release_script"
grep -q "EMERGENCY RELEASE: skipping release:smoke" <<<"$release_script"
grep -q "pnpm release:check" <<<"$release_script"

echo "release options test passed"
