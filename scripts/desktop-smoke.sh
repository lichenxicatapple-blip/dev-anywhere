#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT}/artifacts/desktop-smoke"
BASE_URL="http://127.0.0.1:5173"

usage() {
  echo "usage: bash scripts/desktop-smoke.sh [--base-url <url>]" >&2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --base-url)
      BASE_URL="${2:-}"
      [[ -n "$BASE_URL" ]] || { echo "ERROR: missing value for --base-url" >&2; exit 2; }
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#--base-url=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

source "$ROOT/scripts/lib/smoke-common.sh"

mkdir -p "$ARTIFACT_DIR"
cd "$ROOT"

smoke_use_stable_node
smoke_require_local_base_url "$BASE_URL" "desktop smoke"
trap smoke_cleanup EXIT

smoke_start_vite_if_needed "$ROOT" "$ARTIFACT_DIR" "$BASE_URL"

WEB_BASE_URL="$BASE_URL" pnpm --filter @dev-anywhere/web run test:e2e:desktop
