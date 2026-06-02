#!/usr/bin/env bash
# Vitest wrapper: prefer local Node 22 for stable jsdom/localStorage behavior.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/smoke-common.sh"

smoke_use_stable_node
unset NO_COLOR FORCE_COLOR
exec vitest run "$@"
