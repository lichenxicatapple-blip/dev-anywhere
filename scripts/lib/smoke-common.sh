#!/usr/bin/env bash

SMOKE_STARTED_VITE_PID="${SMOKE_STARTED_VITE_PID:-}"

smoke_use_stable_node() {
  # Playwright 1.52 hangs under the currently installed Node 25 on this machine.
  # Prefer local Node 22 when available; production Docker images already use Node 22.
  for node_bin in "$HOME"/.nvm/versions/node/v22*/bin; do
    if [[ -x "$node_bin/node" ]]; then
      export PATH="$node_bin:$PATH"
      break
    fi
  done
}

smoke_is_local_url() {
  local url="$1"
  [[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] ||
    [[ "$url" =~ ^http://\[::1\](:[0-9]+)?(/|$) ]]
}

smoke_require_local_base_url() {
  local url="$1"
  local label="$2"

  if smoke_is_local_url "$url"; then
    return
  fi

  echo "ERROR: $label is local-first and refuses remote WEB_BASE_URL: $url" >&2
  echo "Use http://127.0.0.1:5173, or run a separate release/cloud check after deployment." >&2
  exit 2
}

smoke_check_web_entry() {
  local web_base_url="$1"
  local entry_url="${web_base_url%/}/src/app.tsx"
  local body

  if ! body="$(curl --noproxy '*' -fsS "$entry_url" 2>/dev/null)"; then
    return 2
  fi

  if printf '%s\n' "$body" | grep -qE 'Internal Server Error|Failed to resolve import|vite:import-analysis|ErrorOverlay'; then
    return 1
  fi

  return 0
}

smoke_report_web_entry_error() {
  local web_base_url="$1"
  local artifact_dir="$2"
  local entry_url="${web_base_url%/}/src/app.tsx"

  mkdir -p "$artifact_dir"
  curl --noproxy '*' -sS "$entry_url" >"$artifact_dir/web-entry-error.html" 2>/dev/null || true
  echo "ERROR: Web dev server responds at $web_base_url but cannot compile the app entry." >&2
  echo "Saved the Vite error response to: $artifact_dir/web-entry-error.html" >&2
  echo "Restart the stale dev server, or set WEB_BASE_URL and DEV_ANYWHERE_WEB_PORT to a clean local port." >&2
}

smoke_start_vite_if_needed() {
  local root="$1"
  local artifact_dir="$2"
  local web_base_url="$3"
  local web_port="${DEV_ANYWHERE_WEB_PORT:-5173}"

  if curl --noproxy '*' -fsS "$web_base_url" >/dev/null 2>&1; then
    if smoke_check_web_entry "$web_base_url"; then
      return
    fi
    smoke_report_web_entry_error "$web_base_url" "$artifact_dir"
    exit 1
  fi

  if ! smoke_is_local_url "$web_base_url"; then
    echo "ERROR: Web server is not reachable at $web_base_url" >&2
    exit 1
  fi

  if [[ "$web_base_url" =~ :([0-9]+)(/|$) ]]; then
    web_port="${BASH_REMATCH[1]}"
  fi

  if lsof -nP -iTCP:"$web_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: Port $web_port is already in use, but $web_base_url is not healthy." >&2
    echo "Set WEB_BASE_URL and DEV_ANYWHERE_WEB_PORT to a clean local port." >&2
    exit 1
  fi

  mkdir -p "$artifact_dir"
  pnpm --dir "$root/apps/web" exec vite --host 127.0.0.1 --port "$web_port" \
    >"$artifact_dir/vite.log" 2>&1 &
  SMOKE_STARTED_VITE_PID="$!"

  for _ in {1..40}; do
    if smoke_check_web_entry "$web_base_url"; then
      return
    fi
    sleep 0.25
  done

  if curl --noproxy '*' -fsS "$web_base_url" >/dev/null 2>&1; then
    smoke_report_web_entry_error "$web_base_url" "$artifact_dir"
  else
    echo "ERROR: Vite did not respond at $web_base_url" >&2
  fi
  tail -n 80 "$artifact_dir/vite.log" 2>/dev/null || true
  exit 1
}

smoke_require_local_real_chain() {
  local root="$1"
  local relay_port="${DEV_ANYWHERE_RELAY_PORT:-3100}"
  local status

  if ! curl --noproxy '*' -fsS "http://127.0.0.1:$relay_port/health" >/dev/null 2>&1; then
    echo "ERROR: local relay is not healthy at http://127.0.0.1:$relay_port/health" >&2
    echo "Run: pnpm dev:restart" >&2
    exit 1
  fi

  if ! status="$(
    INIT_CWD="$root" pnpm --filter @dev-anywhere/proxy run dev -- serve status 2>&1
  )"; then
    echo "ERROR: proxy serve status failed" >&2
    printf '%s\n' "$status" >&2
    exit 1
  fi

  if ! printf '%s\n' "$status" | grep -q "Service: running"; then
    echo "ERROR: local proxy serve daemon is not running" >&2
    printf '%s\n' "$status" >&2
    echo "Run: pnpm dev:restart" >&2
    exit 1
  fi

  if ! printf '%s\n' "$status" | grep -qE "Env:[[:space:]]+local"; then
    echo "ERROR: proxy serve is not using the local environment" >&2
    printf '%s\n' "$status" >&2
    echo "Run: INIT_CWD=\"$root\" pnpm --filter @dev-anywhere/proxy run dev --" >&2
    echo "       serve restart --env local" >&2
    exit 1
  fi

  if ! printf '%s\n' "$status" | grep -q "Relay:   connected"; then
    echo "ERROR: proxy serve is not connected to the local relay" >&2
    printf '%s\n' "$status" >&2
    exit 1
  fi
}

smoke_cleanup() {
  if [[ -n "$SMOKE_STARTED_VITE_PID" ]]; then
    kill "$SMOKE_STARTED_VITE_PID" 2>/dev/null || true
  fi
}
