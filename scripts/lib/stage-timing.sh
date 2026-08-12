#!/usr/bin/env bash

STAGE_TIMING_REPORT=""

stage_timing_init() {
  STAGE_TIMING_REPORT="$1"
  mkdir -p "$(dirname "$STAGE_TIMING_REPORT")"
  printf 'stage\tstatus\tduration_s\n' >"$STAGE_TIMING_REPORT"
}

run_timed_stage() {
  local stage="$1"
  shift
  local started_at finished_at duration status rc
  started_at="$(date +%s)"
  echo ""
  echo "=== $stage ==="

  if "$@"; then
    rc=0
    status="passed"
  else
    rc="$?"
    status="failed($rc)"
  fi

  finished_at="$(date +%s)"
  duration=$((finished_at - started_at))
  printf '%s\t%s\t%s\n' "$stage" "$status" "$duration" >>"$STAGE_TIMING_REPORT"
  echo "[timing] $stage status=$status duration=${duration}s"
  return "$rc"
}

print_stage_timing_summary() {
  local total
  total="$(awk -F '\t' 'NR > 1 { sum += $3 } END { print sum + 0 }' "$STAGE_TIMING_REPORT")"
  echo ""
  echo "=== Timing summary ==="
  awk -F '\t' 'NR > 1 { printf "  %-24s %-12s %ss\n", $1, $2, $3 }' "$STAGE_TIMING_REPORT"
  echo "  total=${total}s"
  echo "  report=$STAGE_TIMING_REPORT"
}
