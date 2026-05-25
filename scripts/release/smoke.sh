#!/usr/bin/env bash
# Release smoke gate. Real-chain checks own the local profile explicitly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

RELEASE_MOBILE_EMULATORS="${RELEASE_MOBILE_EMULATORS:-2}"
RELEASE_MOBILE_KEEP_EMULATORS="${RELEASE_MOBILE_KEEP_EMULATORS:-0}"

cleanup_mobile_emulators() {
  if [[ "$RELEASE_MOBILE_KEEP_EMULATORS" == "1" ]]; then
    return
  fi
  bash scripts/test/mobile-emulators.sh stop "$RELEASE_MOBILE_EMULATORS" >/dev/null 2>&1 || true
}

pnpm dev:restart -- --profile local --relay local --relay-port 3100 --web-port 5173
pnpm test:layout
pnpm test:pc
WEB_BASE_URL=http://localhost:5173 \
  bash scripts/test/pc.sh \
    e2e/pc/pty-input.spec.ts \
    e2e/pc/pty-scroll.spec.ts \
    e2e/pc/pty-trace.spec.ts \
    e2e/pc/pty-geometry.spec.ts \
    e2e/pc/clipboard-image.spec.ts \
    e2e/pc/image-preview.spec.ts
DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 \
  WEB_BASE_URL=http://localhost:5173 \
  bash scripts/test/pc.sh e2e/pc/real-clipboard-image.spec.ts
pnpm dev:chaos -- --profile local --relay local --relay-port 3100 --web-port 5173 --base-url http://localhost:5173
if [[ "$RELEASE_MOBILE_KEEP_EMULATORS" != "1" ]]; then
  trap cleanup_mobile_emulators EXIT
fi
bash scripts/test/mobile-emulators.sh start "$RELEASE_MOBILE_EMULATORS"
TEST_MOBILE_REQUIRE_EMULATOR=1 pnpm test:mobile
