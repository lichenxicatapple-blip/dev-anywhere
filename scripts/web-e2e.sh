#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT}/artifacts/web-e2e"
WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:5173}"

source "$ROOT/scripts/lib/smoke-common.sh"

smoke_use_stable_node
trap smoke_cleanup EXIT

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"

if [[ "$NODE_MAJOR" -ge 25 ]]; then
  echo "ERROR: Playwright E2E refuses Node $NODE_VERSION." >&2
  echo "Playwright 1.52 can hang before worker output under Node 25; use Node 22 for smoke/E2E." >&2
  exit 2
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if smoke_is_local_url "$WEB_BASE_URL"; then
  smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$WEB_BASE_URL"
fi

cd "$ROOT/apps/web"
WEB_BASE_URL="$WEB_BASE_URL" exec ./node_modules/.bin/playwright test "$@"
