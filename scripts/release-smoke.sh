#!/usr/bin/env bash
# Release smoke gate. Real-chain checks run under local proxy env and restore the previous env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm desktop:smoke

scripts/with-proxy-env.sh local -- bash -lc '
  set -euo pipefail
  pnpm dev:restart
  pnpm mobile:smoke
  bash scripts/web-e2e.sh e2e/pty-smoke.spec.ts e2e/clipboard-image.spec.ts --project=desktop
  DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 \
    WEB_BASE_URL=http://localhost:5173 \
    pnpm --filter @dev-anywhere/web run test:e2e -- e2e/real-clipboard-image.spec.ts --project=desktop
  pnpm dev:chaos
'
