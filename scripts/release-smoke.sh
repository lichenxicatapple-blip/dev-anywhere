#!/usr/bin/env bash
# Release smoke gate. Real-chain checks own the local profile explicitly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm dev:restart -- --profile local --relay local --relay-port 3100 --web-port 5173
pnpm desktop:smoke
pnpm mobile:smoke -- --profile local --relay local --relay-port 3100 --base-url http://localhost:5173
bash scripts/web-e2e.sh --base-url http://localhost:5173 -- e2e/pty-smoke.spec.ts e2e/clipboard-image.spec.ts --project=desktop
DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE=1 \
  WEB_BASE_URL=http://localhost:5173 \
  pnpm --filter @dev-anywhere/web run test:e2e -- e2e/real-clipboard-image.spec.ts --project=desktop
pnpm dev:chaos -- --profile local --relay local --relay-port 3100 --web-port 5173 --base-url http://localhost:5173
