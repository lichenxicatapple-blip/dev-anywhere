#!/usr/bin/env bash
# Mobile test dispatcher. Serial execution is the safe default; multiple Android
# emulators are used only when TEST_MOBILE_PARALLEL_WORKERS explicitly opts in.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/e2e-tiers.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

REQUESTED_PARALLEL_WORKERS="${TEST_MOBILE_PARALLEL_WORKERS:-}"
ROOT_ARTIFACT_DIR="${TEST_MOBILE_ARTIFACT_DIR:-$ROOT/artifacts/test-mobile}"
BASE_CDP_PORT="${TIER_MOBILE_CDP_PORT:-9222}"
EXPLICIT_EMULATOR_SERIALS="${TEST_MOBILE_EMULATOR_SERIALS:-}"
DEDICATED_BASE_PORT="${DEV_ANYWHERE_MOBILE_BASE_PORT:-5570}"
DEDICATED_SCAN_COUNT="${DEV_ANYWHERE_MOBILE_SCAN_COUNT:-8}"

mkdir -p "$ROOT_ARTIFACT_DIR"

mobile_parallel_collect_all_emulators() {
  ALL_DEVICES=()
  while read -r serial state _rest; do
    if [[ "$state" == "device" && "$serial" == emulator-* ]]; then
      ALL_DEVICES+=("$serial")
    fi
  done < <(adb devices 2>/dev/null | awk 'NR>1 {print $1, $2}')
}

mobile_parallel_has_device() {
  local candidate="$1"
  local device
  if [[ "${#ALL_DEVICES[@]}" -eq 0 ]]; then
    return 1
  fi
  for device in "${ALL_DEVICES[@]}"; do
    [[ "$device" == "$candidate" ]] && return 0
  done
  return 1
}

mobile_parallel_collect_explicit_emulators() {
  local serials serial
  serials="${EXPLICIT_EMULATOR_SERIALS//,/ }"
  for serial in $serials; do
    if mobile_parallel_has_device "$serial"; then
      DEVICES+=("$serial")
    else
      echo "ERROR: requested mobile emulator is not online: $serial" >&2
      echo "       online emulators: ${ALL_DEVICES[*]:-(none)}" >&2
      exit 2
    fi
  done
}

mobile_parallel_collect_dedicated_emulators() {
  local i port serial
  for ((i = 0; i < DEDICATED_SCAN_COUNT; i++)); do
    port=$((DEDICATED_BASE_PORT + i * 2))
    serial="emulator-$port"
    if mobile_parallel_has_device "$serial"; then
      DEVICES+=("$serial")
    fi
  done
}

mobile_parallel_collect_emulators() {
  DEVICES=()
  mobile_parallel_collect_all_emulators

  if [[ -n "$EXPLICIT_EMULATOR_SERIALS" ]]; then
    mobile_parallel_collect_explicit_emulators
    return
  fi

  mobile_parallel_collect_dedicated_emulators
  if [[ "${#DEVICES[@]}" -gt 0 ]]; then
    return
  fi

  if [[ "${#ALL_DEVICES[@]}" -gt 0 ]]; then
    DEVICES=("${ALL_DEVICES[@]}")
  fi
}

mobile_parallel_collect_specs() {
  if [[ "$#" -gt 0 ]]; then
    printf '%s\n' "$@"
    return
  fi

  (
    cd "$ROOT/apps/web"
    printf '%s\n' e2e/mobile/*.spec.ts
  )
}

mobile_parallel_run_serial() {
  local serial="${ANDROID_SERIAL:-}"
  if [[ -z "$serial" && -n "$EXPLICIT_EMULATOR_SERIALS" ]]; then
    serial="${EXPLICIT_EMULATOR_SERIALS//,/ }"
    serial="${serial%% *}"
  fi
  if [[ -z "$serial" ]] && command -v adb >/dev/null 2>&1; then
    mobile_parallel_collect_emulators
    serial="${DEVICES[0]:-}"
  fi
  if [[ -n "$serial" ]]; then
    export ANDROID_SERIAL="$serial"
  fi
  exec bash "$ROOT/scripts/test/mobile.sh" "$@"
}

if ! command -v adb >/dev/null 2>&1; then
  mobile_parallel_run_serial "$@"
fi

if [[ -n "$REQUESTED_PARALLEL_WORKERS" && ! "$REQUESTED_PARALLEL_WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: TEST_MOBILE_PARALLEL_WORKERS must be a positive integer." >&2
  exit 2
fi

if [[ -n "${ANDROID_SERIAL:-}" || -z "$REQUESTED_PARALLEL_WORKERS" || "$REQUESTED_PARALLEL_WORKERS" == "1" ]]; then
  mobile_parallel_run_serial "$@"
fi

mobile_parallel_collect_emulators
if [[ "${#DEVICES[@]}" -lt 2 ]]; then
  mobile_parallel_run_serial "$@"
fi
PARALLEL_WORKERS="$REQUESTED_PARALLEL_WORKERS"

SPECS=()
while IFS= read -r spec; do
  [[ -n "$spec" ]] && SPECS+=("$spec")
done < <(mobile_parallel_collect_specs "$@")

if [[ "${#SPECS[@]}" -lt 2 ]]; then
  mobile_parallel_run_serial "$@"
fi

# Real Android IME + visualViewport propagation becomes nondeterministic when a
# second emulator is under load on the same host. Keep every spec that drives the
# native keyboard on one otherwise-idle emulator; all other mobile specs remain parallel.
SERIAL_SPECS=()
PARALLEL_SPECS=()
for spec in "${SPECS[@]}"; do
  case "$spec" in
    *chat-keyboard-layout.spec.ts | \
      *pty-horizontal-scroll.spec.ts | \
      *pty-input-keyboard.spec.ts | \
      *pty-long-press-copy.spec.ts | \
      *pty-mobile-controls-repeat.spec.ts | \
      *pty-mobile-controls.spec.ts | \
      *pty-paste.spec.ts)
      SERIAL_SPECS+=("$spec")
      ;;
    *) PARALLEL_SPECS+=("$spec") ;;
  esac
done
SPECS=("${PARALLEL_SPECS[@]}")

if [[ "$PARALLEL_WORKERS" -gt "${#DEVICES[@]}" ]]; then
  PARALLEL_WORKERS="${#DEVICES[@]}"
fi
if [[ "$PARALLEL_WORKERS" -gt "${#SPECS[@]}" ]]; then
  PARALLEL_WORKERS="${#SPECS[@]}"
fi
echo "[mobile-parallel] workers=$PARALLEL_WORKERS devices=${DEVICES[*]}"

PIDS=()
SHARD_LOGS=()
SHARD_REPORTS=()

for ((worker = 0; worker < PARALLEL_WORKERS; worker++)); do
  shard_specs=()
  for ((i = worker; i < ${#SPECS[@]}; i += PARALLEL_WORKERS)); do
    shard_specs+=("${SPECS[i]}")
  done

  shard_dir="$ROOT_ARTIFACT_DIR/shard-$worker"
  shard_log="$shard_dir/output.log"
  mkdir -p "$shard_dir"
  printf '%s\n' "${shard_specs[@]}" >"$shard_dir/specs.txt"

  echo "[mobile-parallel] shard-$worker device=${DEVICES[worker]} specs=${#shard_specs[@]} log=$shard_log"

  (
    export ANDROID_SERIAL="${DEVICES[worker]}"
    export TIER_MOBILE_VITE_PORT="$((TIER_MOBILE_VITE_PORT + worker))"
    export TIER_MOBILE_RELAY_PORT="$((TIER_MOBILE_RELAY_PORT + worker))"
    export TIER_MOBILE_CDP_PORT="$((BASE_CDP_PORT + worker))"
    export TEST_MOBILE_ARTIFACT_DIR="$shard_dir"
    export TEST_MOBILE_RESET_FAIL_FAST=1
    bash "$ROOT/scripts/test/mobile.sh" "${shard_specs[@]}"
  ) >"$shard_log" 2>&1 &

  PIDS+=("$!")
  SHARD_LOGS+=("$shard_log")
  SHARD_REPORTS+=("$shard_dir/mobile-timing.tsv")
done

EXIT_CODE=0
for ((worker = 0; worker < PARALLEL_WORKERS; worker++)); do
  if wait "${PIDS[worker]}"; then
    echo "[mobile-parallel] shard-$worker passed"
  else
    rc="$?"
    echo "[mobile-parallel] shard-$worker failed rc=$rc"
    EXIT_CODE="$rc"
  fi
done

if [[ "$EXIT_CODE" -eq 0 && "${#SERIAL_SPECS[@]}" -gt 0 ]]; then
  serial_dir="$ROOT_ARTIFACT_DIR/serial"
  serial_log="$serial_dir/output.log"
  mkdir -p "$serial_dir"
  printf '%s\n' "${SERIAL_SPECS[@]}" >"$serial_dir/specs.txt"
  echo "[mobile-parallel] exclusive device=${DEVICES[0]} specs=${#SERIAL_SPECS[@]} log=$serial_log"
  if (
    export ANDROID_SERIAL="${DEVICES[0]}"
    export TIER_MOBILE_CDP_PORT="$BASE_CDP_PORT"
    export TEST_MOBILE_ARTIFACT_DIR="$serial_dir"
    export TEST_MOBILE_RESET_FAIL_FAST=1
    bash "$ROOT/scripts/test/mobile.sh" "${SERIAL_SPECS[@]}"
  ) >"$serial_log" 2>&1; then
    echo "[mobile-parallel] exclusive mobile specs passed"
  else
    EXIT_CODE="$?"
    echo "[mobile-parallel] exclusive mobile specs failed rc=$EXIT_CODE"
  fi
  SHARD_LOGS+=("$serial_log")
  SHARD_REPORTS+=("$serial_dir/mobile-timing.tsv")
fi

echo ""
echo "[mobile-parallel] shard logs:"
for log_file in "${SHARD_LOGS[@]}"; do
  echo "  $log_file"
done

COMBINED_REPORT="$ROOT_ARTIFACT_DIR/mobile-timing.tsv"
printf 'spec\tstatus\treset_s\ttest_s\ttotal_s\n' >"$COMBINED_REPORT"
for report in "${SHARD_REPORTS[@]}"; do
  if [[ -f "$report" ]]; then
    tail -n +2 "$report" >>"$COMBINED_REPORT"
  fi
done

if [[ -s "$COMBINED_REPORT" ]]; then
  echo "[mobile-parallel] combined timing report: $COMBINED_REPORT"
  awk -F '\t' '
    NR > 1 {
      reset += $3
      test += $4
      total += $5
    }
    END {
      printf "[mobile-parallel] summed shard work reset=%.1fs test=%.1fs total=%.1fs\n", reset, test, total
    }
  ' "$COMBINED_REPORT"
  echo "[mobile-parallel] slowest specs:"
  tail -n +2 "$COMBINED_REPORT" | sort -t "$(printf '\t')" -k5,5nr | head -n "${TEST_MOBILE_TIMING_TOP_N:-8}" | awk -F '\t' '{ printf "  %s total=%ss reset=%ss test=%ss status=%s\n", $1, $5, $3, $4, $2 }'
fi

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo ""
  echo "[mobile-parallel] failing shard tails:"
  for log_file in "${SHARD_LOGS[@]}"; do
    if grep -qE 'failed|ERROR|Timed out|TimeoutError' "$log_file" 2>/dev/null; then
      echo "--- $log_file ---"
      tail -n 120 "$log_file" || true
    fi
  done
fi

exit "$EXIT_CODE"
