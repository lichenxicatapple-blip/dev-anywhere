#!/usr/bin/env bash
# Deploy dev-anywhere on a VPS using the pre-built Relay image from Aliyun ACR.
#
# Two modes:
#
#   1) Run from your laptop; auto-ssh into a remote VPS and deploy there:
#        ./scripts/deploy/install-relay.sh --ssh user@vps-host <domain-or-public-ip>
#      Requires ssh-key access to the remote host and sudo for that user.
#
#   2) Run directly on the VPS:
#        sudo ./scripts/deploy/install-relay.sh <domain-or-public-ip>
#
# Arguments:
#   public_host  — public DNS name pointing at the VPS, or its public IPv4 address.
#   proxy_token  — optional; a fresh RELAY_PROXY_TOKEN is generated when omitted.
#   client_token — optional; a fresh RELAY_CLIENT_TOKEN is generated when omitted.
#
# Environment overrides:
#   REGISTRY_BASE — registry + namespace prefix for the image
#                   (default: Aliyun ACR personal instance bound to this project):
#                   crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip
#                   To deploy from GHCR explicitly:
#                   REGISTRY_BASE=ghcr.io/lichenxicatapple-blip
#   IMAGE_TAG     — image tag to pull (default: latest).
#   DEV_ANYWHERE_RELAY_PORT — loopback relay port on the VPS (default: 3100).
#
# Layout created on the VPS:
#   /opt/dev-anywhere/
#     ├─ docker-compose.yml
#     └─ .env                # RELAY_PROXY_TOKEN + RELAY_CLIENT_TOKEN, chmod 600
#
# Docker starts one loopback-only Relay service that serves the Web UI, HTTP API,
# files, voice endpoints, and WebSockets. Host nginx owns public 80/443 and
# terminates TLS, leaving the VPS free to host more services.
# Domain certificates use the host's regular Certbot state. Public-IP
# certificates use isolated state under /opt/dev-anywhere/certbot-ip so their
# short renewal cycle cannot contend with certificates for other sites.
#
set -euo pipefail

if ! declare -F render_dev_anywhere_compose >/dev/null 2>&1; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  RENDER_LIB="$SCRIPT_DIR/../lib/install-relay-render.sh"
  if [ -f "$RENDER_LIB" ]; then
    # shellcheck source=scripts/lib/install-relay-render.sh
    source "$RENDER_LIB"
  fi
fi

# --ssh mode: feed this very script over stdin to a remote bash.
if [ "${1:-}" = "--ssh" ]; then
  shift
  SSH_HOST="${1:?Usage: install-relay.sh --ssh <ssh-host> <domain-or-public-ip> [proxy_token] [client_token]}"
  PUBLIC_HOST_ARG="${2:?Usage: install-relay.sh --ssh <ssh-host> <domain-or-public-ip> [proxy_token] [client_token]}"
  PROXY_TOKEN_ARG="${3:-}"
  CLIENT_TOKEN_ARG="${4:-}"
  SELF_PATH="${BASH_SOURCE[0]}"
  if [ ! -f "$SELF_PATH" ]; then
    echo "error: --ssh mode needs the script on disk (can't pipe from curl)" >&2
    exit 1
  fi
  SELF_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"
  RENDER_LIB="$SELF_DIR/../lib/install-relay-render.sh"
  if [ ! -f "$RENDER_LIB" ]; then
    echo "error: missing $RENDER_LIB" >&2
    exit 1
  fi
  echo "==> deploying to $SSH_HOST (public host: $PUBLIC_HOST_ARG)"
  # sudo strips env vars; use `sudo env VAR=val` to thread REGISTRY_BASE / IMAGE_TAG through
  {
    cat "$RENDER_LIB"
    printf '\n'
    cat "$SELF_PATH"
  } | ssh -t "$SSH_HOST" "sudo env REGISTRY_BASE='${REGISTRY_BASE:-}' IMAGE_TAG='${IMAGE_TAG:-}' DEV_ANYWHERE_RELAY_PORT='${DEV_ANYWHERE_RELAY_PORT:-}' bash -s -- '$PUBLIC_HOST_ARG' '$PROXY_TOKEN_ARG' '$CLIENT_TOKEN_ARG'"
  exit $?
fi

PUBLIC_HOST="${1:?Usage: install-relay.sh <domain-or-public-ip> [proxy_token] [client_token]  |  install-relay.sh --ssh <host> <domain-or-public-ip> [proxy_token] [client_token]}"
PROXY_TOKEN="${2:-}"
CLIENT_TOKEN="${3:-}"
INSTALL_DIR="/opt/dev-anywhere"
CERT_NAME="${CERT_NAME:-relay}"   # existing deployments already use this Let's Encrypt cert name
NGINX_SITE_NAME="${NGINX_SITE_NAME:-dev-anywhere}"
NGINX_SITE_PATH="/etc/nginx/conf.d/${NGINX_SITE_NAME}.conf"
CERTBOT_WEBROOT="/var/www/certbot"
CERTBOT_CONFIG_DIR="/etc/letsencrypt"
CERTBOT_WORK_DIR="/var/lib/letsencrypt"
CERTBOT_LOGS_DIR="/var/log/letsencrypt"
CERT_LIVE_ROOT="$CERTBOT_CONFIG_DIR/live"
DEV_ANYWHERE_RELAY_PORT="${DEV_ANYWHERE_RELAY_PORT:-3100}"
# REGISTRY_BASE is the "registry/namespace" prefix. Production defaults to the
# public Aliyun ACR image mirror used by the China VPS deployment path.
REGISTRY_BASE="${REGISTRY_BASE:-crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
RELAY_IMAGE="${REGISTRY_BASE}/dev-anywhere-relay:${IMAGE_TAG}"

if ! TARGET_KIND="$(dev_anywhere_public_host_kind "$PUBLIC_HOST")"; then
  echo "error: public host must be a valid domain or public IPv4 address without a scheme, port, or path" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

echo "==> public host:  $PUBLIC_HOST ($TARGET_KIND)"
echo "==> install dir:  $INSTALL_DIR"
echo "==> relay image:  $RELAY_IMAGE"
echo "==> relay port:   127.0.0.1:$DEV_ANYWHERE_RELAY_PORT"
echo "==> nginx site:   $NGINX_SITE_PATH"

if ! declare -F render_dev_anywhere_compose >/dev/null 2>&1; then
  echo "error: install-relay render helpers are not loaded" >&2
  exit 1
fi

# Step 1: install docker if missing.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose v2 is required" >&2
  exit 1
fi

# Step 2: install host nginx and a suitable Certbot.
install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release && yum install -y "$@"
  else
    echo "error: unsupported distro (need apt-get or yum)" >&2
    exit 1
  fi
}

if ! command -v nginx >/dev/null 2>&1; then
  echo "==> installing nginx"
  install_packages nginx
fi

mkdir -p "$INSTALL_DIR"

CERTBOT_BIN=""
if command -v certbot >/dev/null 2>&1; then
  CERTBOT_BIN="$(command -v certbot)"
fi

if [ "$TARGET_KIND" = "domain" ]; then
  if [ -z "$CERTBOT_BIN" ]; then
    echo "==> installing certbot"
    install_packages certbot
    CERTBOT_BIN="$(command -v certbot)"
  fi
else
  CERTBOT_VENV="$INSTALL_DIR/certbot-venv"
  CERTBOT_STATE_DIR="$INSTALL_DIR/certbot-ip"
  CERTBOT_CONFIG_DIR="$CERTBOT_STATE_DIR/config"
  CERTBOT_WORK_DIR="$CERTBOT_STATE_DIR/work"
  CERTBOT_LOGS_DIR="$CERTBOT_STATE_DIR/logs"
  CERT_LIVE_ROOT="$CERTBOT_CONFIG_DIR/live"
  mkdir -p "$CERTBOT_CONFIG_DIR" "$CERTBOT_WORK_DIR" "$CERTBOT_LOGS_DIR"

  if [ -x "$CERTBOT_VENV/bin/certbot" ] &&
    dev_anywhere_certbot_supports_ip_certificates "$("$CERTBOT_VENV/bin/certbot" --version 2>&1)"; then
    CERTBOT_BIN="$CERTBOT_VENV/bin/certbot"
  elif [ -n "$CERTBOT_BIN" ] &&
    dev_anywhere_certbot_supports_ip_certificates "$("$CERTBOT_BIN" --version 2>&1)"; then
    :
  else
    echo "==> installing Certbot 5.4+ for public IP certificates"
    if command -v apt-get >/dev/null 2>&1; then
      install_packages python3 python3-venv
    else
      install_packages python3
    fi
    if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
      echo "error: public IP deployment requires Python 3.10+ to install Certbot 5.4+" >&2
      exit 1
    fi
    python3 -m venv "$CERTBOT_VENV"
    "$CERTBOT_VENV/bin/python" -m pip install --disable-pip-version-check --upgrade pip
    "$CERTBOT_VENV/bin/python" -m pip install --disable-pip-version-check "certbot>=5.4"
    CERTBOT_BIN="$CERTBOT_VENV/bin/certbot"
  fi

  if ! dev_anywhere_certbot_supports_ip_certificates "$("$CERTBOT_BIN" --version 2>&1)"; then
    echo "error: public IP deployment requires Certbot 5.4 or later" >&2
    exit 1
  fi
fi

echo "==> certbot:      $CERTBOT_BIN ($("$CERTBOT_BIN" --version 2>&1))"

# Stop old docker-owned nginx before host nginx takes 80/443.
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  (cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true)
fi
docker rm -f dev-anywhere-nginx 2>/dev/null || true

mkdir -p "$CERTBOT_WEBROOT" "$(dirname "$NGINX_SITE_PATH")"

# Step 3: obtain the TLS certificate through host nginx webroot.
CERT_PATH="$CERT_LIVE_ROOT/$CERT_NAME/fullchain.pem"
NEED_CERT=0
if [ ! -f "$CERT_PATH" ]; then
  NEED_CERT=1
elif [ "$TARGET_KIND" = "ip" ]; then
  if ! openssl x509 -in "$CERT_PATH" -noout -checkip "$PUBLIC_HOST" >/dev/null 2>&1; then
    echo "==> existing cert name '$CERT_NAME' does not cover $PUBLIC_HOST; renewing"
    NEED_CERT=1
  else
    echo "==> cert already covers $PUBLIC_HOST at $CERT_LIVE_ROOT/$CERT_NAME"
  fi
elif ! openssl x509 -in "$CERT_PATH" -noout -checkhost "$PUBLIC_HOST" >/dev/null 2>&1; then
  echo "==> existing cert name '$CERT_NAME' does not cover $PUBLIC_HOST; renewing"
  NEED_CERT=1
else
  echo "==> cert already covers $PUBLIC_HOST at $CERT_LIVE_ROOT/$CERT_NAME"
fi

if [ "$NEED_CERT" -eq 1 ]; then
  echo "==> preparing nginx ACME challenge route"
  render_dev_anywhere_nginx_challenge_conf "$PUBLIC_HOST" > "$NGINX_SITE_PATH"
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl restart nginx
  else
    nginx -s reload 2>/dev/null || nginx
  fi

  echo "==> requesting TLS cert for $PUBLIC_HOST (cert name: $CERT_NAME)"
  request_dev_anywhere_certificate \
    "$CERTBOT_BIN" \
    "$TARGET_KIND" \
    "$PUBLIC_HOST" \
    "$CERTBOT_WEBROOT" \
    "$CERT_NAME" \
    "$CERTBOT_CONFIG_DIR" \
    "$CERTBOT_WORK_DIR" \
    "$CERTBOT_LOGS_DIR"
fi

# Step 4: write host nginx route and docker deployment manifest. No build, no Dockerfile.
echo "==> writing nginx reverse-proxy route"
render_dev_anywhere_nginx_conf \
  "$PUBLIC_HOST" \
  "$CERT_NAME" \
  "$DEV_ANYWHERE_RELAY_PORT" \
  "$CERT_LIVE_ROOT" \
  > "$NGINX_SITE_PATH"
nginx -t
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx || systemctl restart nginx
else
  nginx -s reload 2>/dev/null || nginx
fi

configure_ip_certificate_renewal() {
  local deploy_hook_dir="$CERTBOT_CONFIG_DIR/renewal-hooks/deploy"
  local deploy_hook="$deploy_hook_dir/dev-anywhere-nginx-reload"

  mkdir -p "$deploy_hook_dir"
  render_dev_anywhere_certbot_deploy_hook > "$deploy_hook"
  chmod 755 "$deploy_hook"

  if command -v systemctl >/dev/null 2>&1; then
    render_dev_anywhere_certbot_renew_service \
      "$CERTBOT_BIN" \
      "$CERTBOT_CONFIG_DIR" \
      "$CERTBOT_WORK_DIR" \
      "$CERTBOT_LOGS_DIR" \
      "$CERT_NAME" \
      > /etc/systemd/system/dev-anywhere-certbot-renew.service
    render_dev_anywhere_certbot_renew_timer \
      > /etc/systemd/system/dev-anywhere-certbot-renew.timer
    systemctl daemon-reload
    systemctl enable --now dev-anywhere-certbot-renew.timer
  else
    render_dev_anywhere_certbot_renew_cron \
      "$CERTBOT_BIN" \
      "$CERTBOT_CONFIG_DIR" \
      "$CERTBOT_WORK_DIR" \
      "$CERTBOT_LOGS_DIR" \
      "$CERT_NAME" \
      > /etc/cron.d/dev-anywhere-certbot-renew
    chmod 644 /etc/cron.d/dev-anywhere-certbot-renew
  fi

  echo "==> public IP certificate renewal scheduled twice daily"
}

if [ "$TARGET_KIND" = "ip" ]; then
  configure_ip_certificate_renewal
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

render_dev_anywhere_compose "$RELAY_IMAGE" "$DEV_ANYWHERE_RELAY_PORT" > docker-compose.yml

# Step 5: reuse or generate relay tokens.
if [ -z "$PROXY_TOKEN" ]; then
  if [ -f .env ] && grep -q '^RELAY_PROXY_TOKEN=' .env; then
    PROXY_TOKEN=$(grep '^RELAY_PROXY_TOKEN=' .env | cut -d= -f2-)
    echo "==> reusing existing RELAY_PROXY_TOKEN from $INSTALL_DIR/.env"
  else
    PROXY_TOKEN=$(openssl rand -hex 24)
    echo "==> generated a new RELAY_PROXY_TOKEN"
  fi
fi
if [ -z "$CLIENT_TOKEN" ]; then
  if [ -f .env ] && grep -q '^RELAY_CLIENT_TOKEN=' .env; then
    CLIENT_TOKEN=$(grep '^RELAY_CLIENT_TOKEN=' .env | cut -d= -f2-)
    echo "==> reusing existing RELAY_CLIENT_TOKEN from $INSTALL_DIR/.env"
  else
    CLIENT_TOKEN=$(openssl rand -hex 24)
    echo "==> generated a new RELAY_CLIENT_TOKEN"
  fi
fi
umask 077
cat > .env <<EOF
RELAY_PROXY_TOKEN=$PROXY_TOKEN
RELAY_CLIENT_TOKEN=$CLIENT_TOKEN
PORT=3100
LOG_LEVEL=info
DATA_DIR=/data
HEARTBEAT_INTERVAL=30000
EOF
chmod 600 .env

# Step 6: pull images and start the stack.
# Remove pre-existing dev-anywhere containers.
# `docker compose down` alone only sees the compose project in the current dir.
docker compose down --remove-orphans 2>/dev/null || true
docker rm -f dev-anywhere-relay dev-anywhere-nginx 2>/dev/null || true

echo "==> pulling images"
docker compose pull
echo "==> starting containers"
docker compose up -d

cleanup_old_images() {
  echo "==> cleaning old DEV Anywhere images"

  local keep_ids
  keep_ids="$(docker inspect -f '{{.Image}}' dev-anywhere-relay 2>/dev/null | sort -u)"
  if [ -z "$keep_ids" ]; then
    echo "    skip: running images not found"
    return
  fi

  local remove_ids
  remove_ids="$(
    docker images --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' |
      awk '$1 ~ /dev-anywhere/ { print $3 }' |
      sort -u |
      while read -r image_id; do
        [ -z "$image_id" ] && continue
        if ! printf '%s\n' "$keep_ids" | grep -qx "$image_id"; then
          printf '%s\n' "$image_id"
        fi
      done
  )"

  if [ -z "$remove_ids" ]; then
    echo "    no old DEV Anywhere images to remove"
    return
  fi

  printf '%s\n' "$remove_ids" | xargs docker image rm -f
}

# Step 7: verify.
sleep 3
if curl -fsS "https://$PUBLIC_HOST/health" >/dev/null 2>&1; then
  cleanup_old_images
  echo
  echo "=== dev-anywhere deployed ==="
  echo "  Web UI:  https://$PUBLIC_HOST/"
  echo "  Health:  https://$PUBLIC_HOST/health"
  echo "  Proxy:   wss://$PUBLIC_HOST/proxy?token=$PROXY_TOKEN"
  echo "  Client:  wss://$PUBLIC_HOST/client?token=$CLIENT_TOKEN"
  echo "  Client token for Settings -> Relay Token: $CLIENT_TOKEN"
  echo
  echo "Next, on your local machine:"
  echo "  npm install -g @dev-anywhere/proxy"
  echo "  dev-anywhere init"
  echo "  # edit ~/.dev-anywhere/config.json:"
  echo "  #   { \"defaultProfile\": \"default\", \"profiles\": { \"default\": { \"relay\": \"cloud\" } }, \"relays\": { \"cloud\": { \"url\": \"wss://$PUBLIC_HOST\", \"proxyToken\": \"$PROXY_TOKEN\" } } }"
  echo "  dev-anywhere serve start --relay cloud"
  echo
  echo "Open the Web UI URL above once. The client token is stored in local browser storage for future launches."
  echo
  echo "To upgrade later:"
  echo "  sudo env IMAGE_TAG=$IMAGE_TAG ./scripts/deploy/install-relay.sh $PUBLIC_HOST"
else
  echo "error: health check failed; run 'docker compose logs' in $INSTALL_DIR to investigate" >&2
  exit 1
fi
