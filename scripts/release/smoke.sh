#!/usr/bin/env bash
# Fast, deterministic release gate. Keep environment-heavy checks in deep.sh so
# Android/ADB/provider/process faults do not make every version cut unpredictable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/smoke-common.sh"
source "$ROOT/scripts/lib/stage-timing.sh"

ARTIFACT_DIR="${RELEASE_SMOKE_ARTIFACT_DIR:-$ROOT/artifacts/release-smoke}"
BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"
TIMING_REPORT="$ARTIFACT_DIR/timing.tsv"

mkdir -p "$ARTIFACT_DIR"
stage_timing_init "$TIMING_REPORT"
smoke_use_stable_node
trap smoke_cleanup EXIT

run_timed_stage "unit" pnpm test:unit
run_timed_stage "vite-start" smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"
run_timed_stage "layout-e2e" env WEB_BASE_URL="$BASE_URL" pnpm test:layout
# Full fake-relay desktop coverage is fast and deterministic enough to remain blocking.
# Do not list a second subset here: that previously reran six specs already covered by test:pc.
run_timed_stage "desktop-e2e" env WEB_BASE_URL="$BASE_URL" pnpm test:pc

print_stage_timing_summary
echo "release smoke passed"
