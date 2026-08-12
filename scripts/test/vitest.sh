#!/usr/bin/env bash
# Vitest wrapper: prefer local Node 22 for stable jsdom/localStorage behavior.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/smoke-common.sh"

smoke_use_stable_node
unset NO_COLOR FORCE_COLOR
# Unit tests must not inherit provider overrides from the developer's active shell/session.
# Tests that exercise custom binaries set these variables explicitly inside their own process.
unset CLAUDE_BIN CODEX_BIN
exec vitest run "$@"
