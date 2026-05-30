#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-quality.XXXXXX")"
PIDS=()
NAMES=()
LOGS=()

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

run_check() {
  local name="$1"
  shift
  local log_file="$TMP_DIR/$name.log"
  NAMES+=("$name")
  LOGS+=("$log_file")
  echo "START $name"
  (
    "$@"
  ) >"$log_file" 2>&1 &
  PIDS+=("$!")
}

run_check "format" pnpm format:check
run_check "lint" pnpm lint
run_check "typecheck" pnpm -r run typecheck
run_check "knip" pnpm knip
run_check "unit" pnpm test:unit

failed=0
for i in "${!PIDS[@]}"; do
  name="${NAMES[$i]}"
  log_file="${LOGS[$i]}"
  if wait "${PIDS[$i]}"; then
    echo "OK    $name"
  else
    failed=1
    echo "FAIL  $name" >&2
    sed "s/^/[$name] /" "$log_file" >&2
  fi
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK    quality checks passed"
