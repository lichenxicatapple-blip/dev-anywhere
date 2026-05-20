#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF="$ROOT/apps/web/nginx.conf"
DOCKERFILE="$ROOT/apps/web/Dockerfile"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$CONF" ] || fail "missing apps/web/nginx.conf"

grep -F "COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf" "$DOCKERFILE" >/dev/null ||
  fail "web Dockerfile must copy the plain HTTP web nginx config"

grep -F "listen 80;" "$CONF" >/dev/null ||
  fail "web nginx config must listen on plain HTTP port 80 for host nginx"

if grep -E "ssl_certificate|listen 443|return 301|proxy_pass" "$CONF" >/dev/null; then
  fail "web nginx config must not terminate TLS, redirect to HTTPS, or proxy relay routes"
fi

grep -F "try_files \$uri /index.html;" "$CONF" >/dev/null ||
  fail "web nginx config must preserve SPA fallback"

echo "web nginx config tests passed"
