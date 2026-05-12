#!/usr/bin/env bash
# Tier 1 - vitest across all workspaces.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pnpm -r test "$@"
