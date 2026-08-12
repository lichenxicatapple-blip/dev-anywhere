#!/usr/bin/env bash
# Slow, environment-dependent release validation. Process Chaos and Android Chrome
# are mandatory in release.sh; the real file transport chain remains opt-in.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/stage-timing.sh"

ARTIFACT_DIR="${RELEASE_DEEP_ARTIFACT_DIR:-$ROOT/artifacts/release-deep}"
TIMING_REPORT="$ARTIFACT_DIR/timing.tsv"
# Release validation favors deterministic native IME/visualViewport behavior over
# emulator sharding. Developers can still opt into a larger pool explicitly.
RELEASE_MOBILE_EMULATORS="${RELEASE_MOBILE_EMULATORS:-1}"
RELEASE_MOBILE_KEEP_EMULATORS="${RELEASE_MOBILE_KEEP_EMULATORS:-0}"
RELEASE_MOBILE_GPU_MODE="${RELEASE_MOBILE_GPU_MODE:-swiftshader_indirect}"
RELEASE_DEEP_SCOPE="${RELEASE_DEEP_SCOPE:-all}"

case "$RELEASE_DEEP_SCOPE" in
  all | real | chaos | mobile) ;;
  *)
    echo "ERROR: RELEASE_DEEP_SCOPE must be all, real, chaos, or mobile (got: $RELEASE_DEEP_SCOPE)" >&2
    exit 2
    ;;
esac

cleanup_mobile_emulators() {
  if [[ "$RELEASE_MOBILE_KEEP_EMULATORS" == "1" ]]; then
    return
  fi
  bash scripts/test/mobile-emulators.sh stop "$RELEASE_MOBILE_EMULATORS" >/dev/null 2>&1 || true
}

mkdir -p "$ARTIFACT_DIR"
stage_timing_init "$TIMING_REPORT"

if [[ "${RELEASE_DEEP_SKIP_FAST:-0}" != "1" ]]; then
  run_timed_stage "fast-release-gate" pnpm release:smoke
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "real" ]]; then
  run_timed_stage "local-chain-start" pnpm dev:restart -- --profile local --relay local --relay-port 3100 --web-port 5173
  run_timed_stage "real-file-chain" env \
    DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 \
    WEB_BASE_URL=http://localhost:5173 \
    bash scripts/test/pc.sh e2e/pc/real-clipboard-image.spec.ts
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "chaos" ]]; then
  run_timed_stage "process-chaos" pnpm dev:chaos -- --profile local --relay local --relay-port 3100 --web-port 5173 --base-url http://localhost:5173
fi
if [[ "$RELEASE_DEEP_SCOPE" == "all" || "$RELEASE_DEEP_SCOPE" == "mobile" ]]; then
  trap cleanup_mobile_emulators EXIT
  run_timed_stage "mobile-emulator-start" env \
    DEV_ANYWHERE_MOBILE_GPU_MODE="$RELEASE_MOBILE_GPU_MODE" \
    bash scripts/test/mobile-emulators.sh start "$RELEASE_MOBILE_EMULATORS"
  run_timed_stage "android-e2e" env \
    TEST_MOBILE_REQUIRE_EMULATOR=1 \
    TEST_MOBILE_RESET_FAIL_FAST=1 \
    pnpm test:mobile
fi

print_stage_timing_summary
echo "deep release validation passed"
