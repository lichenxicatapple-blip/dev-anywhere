#!/usr/bin/env bash
# Tier 1 - vitest across all workspaces.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# One Vitest project already parallelizes its files. Running every workspace at
# once creates a second concurrency layer that competes for timers and loopback
# sockets without reducing the critical path reliably.
exec pnpm -r --workspace-concurrency=1 test "$@"
