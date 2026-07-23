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

assert_success() {
  if ! "$@"; then
    fail "expected command to succeed: $*"
  fi
}

assert_failure() {
  if "$@"; then
    fail "expected command to fail: $*"
  fi
}

assert_success dev_anywhere_is_ipv4_address "203.0.113.10"
assert_success dev_anywhere_is_ipv4_address "1.1.1.1"
assert_failure dev_anywhere_is_ipv4_address "203.0.113.999"
assert_failure dev_anywhere_is_ipv4_address "dev-anywhere.example.com"

assert_success dev_anywhere_is_domain_name "dev-anywhere.example.com"
assert_success dev_anywhere_is_domain_name "relay.example.cn"
assert_failure dev_anywhere_is_domain_name "https://example.com"
assert_failure dev_anywhere_is_domain_name "relay_example.com"
assert_failure dev_anywhere_is_domain_name "999.999"
assert_failure dev_anywhere_is_domain_name "-relay.example.com"

assert_success test "$(dev_anywhere_public_host_kind "203.0.113.10")" = "ip"
assert_success test "$(dev_anywhere_public_host_kind "relay.example.com")" = "domain"
assert_failure dev_anywhere_public_host_kind "relay;include.example.com"

assert_success dev_anywhere_certbot_supports_ip_certificates "certbot 5.4.0"
assert_success dev_anywhere_certbot_supports_ip_certificates "certbot 6.0.0"
assert_failure dev_anywhere_certbot_supports_ip_certificates "certbot 5.3.1"
assert_failure dev_anywhere_certbot_supports_ip_certificates "missing"

compose="$(
  render_dev_anywhere_compose \
    "registry.example/dev-anywhere-relay:0.3.1" \
    "3100"
)"
assert_contains "$compose" "container_name: dev-anywhere-relay"
assert_contains "$compose" '"127.0.0.1:3100:3100"'
assert_not_contains "$compose" "dev-anywhere-web"
assert_not_contains "$compose" '"80:80"'
assert_not_contains "$compose" '"443:443"'
assert_not_contains "$compose" "container_name: dev-anywhere-nginx"

nginx="$(
  render_dev_anywhere_nginx_conf \
    "dev-anywhere.example.com" \
    "relay" \
    "3100"
)"
assert_contains "$nginx" "server_name dev-anywhere.example.com;"
assert_contains "$nginx" "listen 443 ssl http2;"
assert_not_contains "$nginx" "http2 on;"
assert_contains "$nginx" "ssl_certificate /etc/letsencrypt/live/relay/fullchain.pem;"
assert_contains "$nginx" "location ~ ^/(proxy|client|voice/asr|voice/tts)$"
assert_contains "$nginx" 'proxy_set_header Upgrade $http_upgrade;'
assert_contains "$nginx" "proxy_pass http://127.0.0.1:3100;"
assert_contains "$nginx" "location ^~ /api/remote-uploads/"
assert_contains "$nginx" "proxy_request_buffering off;"
assert_not_contains "$nginx" "127.0.0.1:8080"
assert_contains "$nginx" "location /.well-known/acme-challenge/"

challenge="$(
  render_dev_anywhere_nginx_challenge_conf "dev-anywhere.example.com"
)"
assert_contains "$challenge" "server_name dev-anywhere.example.com;"
assert_contains "$challenge" "root /var/www/certbot;"
assert_not_contains "$challenge" "listen 443"

ip_nginx="$(
  render_dev_anywhere_nginx_conf \
    "203.0.113.10" \
    "relay" \
    "3100" \
    "/opt/dev-anywhere/certbot-ip/config/live"
)"
assert_contains "$ip_nginx" "server_name 203.0.113.10;"
assert_contains "$ip_nginx" "listen 443 ssl http2 default_server;"
assert_contains "$ip_nginx" \
  "ssl_certificate /opt/dev-anywhere/certbot-ip/config/live/relay/fullchain.pem;"
assert_contains "$ip_nginx" 'return 301 https://$host$request_uri;'
assert_not_contains "$ip_nginx" "dev-anywhere.example.com"

assert_not_contains "$nginx" "listen 443 ssl http2 default_server;"

capture_certbot() {
  printf '%s\n' "$@"
}

domain_certbot="$(
  request_dev_anywhere_certificate \
    capture_certbot \
    domain \
    "dev-anywhere.example.com" \
    "/var/www/certbot" \
    "relay"
)"
assert_contains "$domain_certbot" "-d"
assert_contains "$domain_certbot" "dev-anywhere.example.com"
assert_contains "$domain_certbot" "admin@dev-anywhere.example.com"
assert_not_contains "$domain_certbot" "--ip-address"
assert_not_contains "$domain_certbot" "shortlived"
assert_not_contains "$domain_certbot" "--config-dir"
assert_not_contains "$domain_certbot" "--work-dir"
assert_not_contains "$domain_certbot" "--logs-dir"

ip_certbot="$(
  request_dev_anywhere_certificate \
    capture_certbot \
    ip \
    "203.0.113.10" \
    "/var/www/certbot" \
    "relay" \
    "/opt/dev-anywhere/certbot-ip/config" \
    "/opt/dev-anywhere/certbot-ip/work" \
    "/opt/dev-anywhere/certbot-ip/logs"
)"
assert_contains "$ip_certbot" "--ip-address"
assert_contains "$ip_certbot" "203.0.113.10"
assert_contains "$ip_certbot" "--preferred-profile"
assert_contains "$ip_certbot" "shortlived"
assert_contains "$ip_certbot" "--register-unsafely-without-email"
assert_contains "$ip_certbot" "--config-dir"
assert_contains "$ip_certbot" "/opt/dev-anywhere/certbot-ip/config"
assert_contains "$ip_certbot" "--work-dir"
assert_contains "$ip_certbot" "--logs-dir"
assert_not_contains "$ip_certbot" $'\n-d\n'

deploy_hook="$(render_dev_anywhere_certbot_deploy_hook)"
assert_contains "$deploy_hook" "if ! nginx -t >/dev/null 2>&1; then"
assert_contains "$deploy_hook" "nginx -t"
assert_contains "$deploy_hook" "systemctl reload nginx || systemctl restart nginx"

renew_service="$(
  render_dev_anywhere_certbot_renew_service \
    "/opt/dev-anywhere/certbot-venv/bin/certbot" \
    "/opt/dev-anywhere/certbot-ip/config" \
    "/opt/dev-anywhere/certbot-ip/work" \
    "/opt/dev-anywhere/certbot-ip/logs" \
    "relay"
)"
assert_contains "$renew_service" "Type=oneshot"
assert_contains "$renew_service" \
  "ExecStart=/opt/dev-anywhere/certbot-venv/bin/certbot renew --quiet --no-random-sleep-on-renew --config-dir /opt/dev-anywhere/certbot-ip/config --work-dir /opt/dev-anywhere/certbot-ip/work --logs-dir /opt/dev-anywhere/certbot-ip/logs --cert-name relay"

renew_timer="$(render_dev_anywhere_certbot_renew_timer)"
assert_contains "$renew_timer" "OnActiveSec=12h"
assert_contains "$renew_timer" "OnUnitActiveSec=12h"
assert_contains "$renew_timer" "Persistent=true"
assert_contains "$renew_timer" "WantedBy=timers.target"

renew_cron="$(
  render_dev_anywhere_certbot_renew_cron \
    "/opt/dev-anywhere/certbot-venv/bin/certbot" \
    "/opt/dev-anywhere/certbot-ip/config" \
    "/opt/dev-anywhere/certbot-ip/work" \
    "/opt/dev-anywhere/certbot-ip/logs" \
    "relay"
)"
assert_contains "$renew_cron" \
  "17 */12 * * * root /opt/dev-anywhere/certbot-venv/bin/certbot renew --quiet --no-random-sleep-on-renew --config-dir /opt/dev-anywhere/certbot-ip/config --work-dir /opt/dev-anywhere/certbot-ip/work --logs-dir /opt/dev-anywhere/certbot-ip/logs --cert-name relay"

echo "install-relay render tests passed"
