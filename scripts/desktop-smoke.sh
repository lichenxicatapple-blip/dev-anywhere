#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT}/artifacts/desktop-smoke"
WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"

source "$ROOT/scripts/lib/smoke-common.sh"

mkdir -p "$ARTIFACT_DIR"
cd "$ROOT"

smoke_use_stable_node
smoke_require_local_base_url "$WEB_BASE_URL" "desktop smoke"
trap smoke_cleanup EXIT

smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$WEB_BASE_URL"

WEB_BASE_URL="$WEB_BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e:desktop
