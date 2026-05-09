#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$ROOT/scripts/lib/smoke-common.sh"

smoke_use_stable_node

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

cd "$ROOT/apps/web"
exec ./node_modules/.bin/playwright test "$@"
