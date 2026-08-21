#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENTS="${PTY_SYNC_BENCH_CLIENTS:-1,3,5}"
STAMP="${PTY_SYNC_BENCH_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT="${PTY_SYNC_BENCH_OUTPUT:-}"
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$ROOT/artifacts/benchmarks/pty-sync/${STAMP}-"'{clients}'"-clients.json"
fi

cd "$ROOT"

if [[ "${PTY_SYNC_BENCH_SKIP_BUILD:-0}" != "1" ]]; then
  pnpm build
fi

GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse HEAD)}" \
DEV_ANYWHERE_PTY_SYNC_BENCHMARK=1 \
PTY_SYNC_BENCH_CLIENTS="$CLIENTS" \
PTY_SYNC_BENCH_OUTPUT="$OUTPUT" \
pnpm --dir apps/web exec playwright test \
  --project=device-pc-real \
  --retries=0 \
  e2e/pc/real-pty-sync-benchmark.spec.ts
