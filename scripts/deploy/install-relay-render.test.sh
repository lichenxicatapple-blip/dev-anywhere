#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/install-relay-render.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "missing expected text: $needle"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "unexpected text present: $needle"
  fi
}

compose="$(
  render_dev_anywhere_compose \
    "registry.example/dev-anywhere-relay:0.3.1" \
    "registry.example/dev-anywhere-web:0.3.1" \
    "3100" \
    "8080"
)"
assert_contains "$compose" "container_name: dev-anywhere-relay"
assert_contains "$compose" "container_name: dev-anywhere-web"
assert_contains "$compose" '"127.0.0.1:3100:3100"'
assert_contains "$compose" '"127.0.0.1:8080:80"'
assert_not_contains "$compose" '"80:80"'
assert_not_contains "$compose" '"443:443"'
assert_not_contains "$compose" "container_name: dev-anywhere-nginx"

nginx="$(
  render_dev_anywhere_nginx_conf \
    "dev-anywhere.example.com" \
    "relay" \
    "3100" \
    "8080"
)"
assert_contains "$nginx" "server_name dev-anywhere.example.com;"
assert_contains "$nginx" "listen 443 ssl http2;"
assert_not_contains "$nginx" "http2 on;"
assert_contains "$nginx" "ssl_certificate /etc/letsencrypt/live/relay/fullchain.pem;"
assert_contains "$nginx" "location ~ ^/(proxy|client|voice/asr|voice/tts)$"
assert_contains "$nginx" 'proxy_set_header Upgrade $http_upgrade;'
assert_contains "$nginx" "proxy_pass http://127.0.0.1:3100;"
assert_contains "$nginx" "location ~ ^/(fonts|health|status|api)(/.*)?$"
assert_contains "$nginx" "proxy_pass http://127.0.0.1:8080;"
assert_contains "$nginx" "location /.well-known/acme-challenge/"

challenge="$(
  render_dev_anywhere_nginx_challenge_conf "dev-anywhere.example.com"
)"
assert_contains "$challenge" "server_name dev-anywhere.example.com;"
assert_contains "$challenge" "root /var/www/certbot;"
assert_not_contains "$challenge" "listen 443"

echo "install-relay render tests passed"
