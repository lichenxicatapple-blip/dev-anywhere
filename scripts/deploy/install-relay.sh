#!/usr/bin/env bash
# Deploy dev-anywhere on a VPS using the pre-built Relay image from Aliyun ACR.
#
# Two modes:
#
#   1) Run from your laptop; auto-ssh into a remote VPS and deploy there:
#        ./scripts/deploy/install-relay.sh --ssh user@vps-host dev-anywhere.example.com
#      Requires ssh-key access to the remote host and sudo for that user.
#
#   2) Run directly on the VPS:
#        sudo ./scripts/deploy/install-relay.sh dev-anywhere.example.com
#
# Arguments:
#   domain — public DNS name with an A record pointing at the VPS.
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
# TLS certs live under /etc/letsencrypt/live/relay/ and are auto-renewed by the
# host's certbot cron job.
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
  SSH_HOST="${1:?Usage: install-relay.sh --ssh <ssh-host> <domain> [proxy_token] [client_token]}"
  DOMAIN_ARG="${2:?Usage: install-relay.sh --ssh <ssh-host> <domain> [proxy_token] [client_token]}"
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
  echo "==> deploying to $SSH_HOST (domain: $DOMAIN_ARG)"
  # sudo strips env vars; use `sudo env VAR=val` to thread REGISTRY_BASE / IMAGE_TAG through
  {
    cat "$RENDER_LIB"
    printf '\n'
    cat "$SELF_PATH"
  } | ssh -t "$SSH_HOST" "sudo env REGISTRY_BASE='${REGISTRY_BASE:-}' IMAGE_TAG='${IMAGE_TAG:-}' DEV_ANYWHERE_RELAY_PORT='${DEV_ANYWHERE_RELAY_PORT:-}' bash -s -- '$DOMAIN_ARG' '$PROXY_TOKEN_ARG' '$CLIENT_TOKEN_ARG'"
  exit $?
fi

DOMAIN="${1:?Usage: install-relay.sh <domain> [proxy_token] [client_token]  |  install-relay.sh --ssh <host> <domain> [proxy_token] [client_token]}"
PROXY_TOKEN="${2:-}"
CLIENT_TOKEN="${3:-}"
INSTALL_DIR="/opt/dev-anywhere"
CERT_NAME="${CERT_NAME:-relay}"   # existing deployments already use this Let's Encrypt cert name
NGINX_SITE_NAME="${NGINX_SITE_NAME:-dev-anywhere}"
NGINX_SITE_PATH="/etc/nginx/conf.d/${NGINX_SITE_NAME}.conf"
CERTBOT_WEBROOT="/var/www/certbot"
DEV_ANYWHERE_RELAY_PORT="${DEV_ANYWHERE_RELAY_PORT:-3100}"
# REGISTRY_BASE is the "registry/namespace" prefix. Production defaults to the
# public Aliyun ACR image mirror used by the China VPS deployment path.
REGISTRY_BASE="${REGISTRY_BASE:-crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
RELAY_IMAGE="${REGISTRY_BASE}/dev-anywhere-relay:${IMAGE_TAG}"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

echo "==> domain:       $DOMAIN"
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

# Step 2: install host nginx + certbot if missing.
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
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> installing certbot"
  install_packages certbot
fi

# Stop old docker-owned nginx before host nginx takes 80/443.
if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
  (cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true)
fi
docker rm -f dev-anywhere-nginx 2>/dev/null || true

mkdir -p "$CERTBOT_WEBROOT" "$(dirname "$NGINX_SITE_PATH")"

# Step 3: obtain the SSL certificate through host nginx webroot.
CERT_PATH="/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"
NEED_CERT=0
if [ ! -f "$CERT_PATH" ]; then
  NEED_CERT=1
elif ! openssl x509 -in "$CERT_PATH" -noout -checkhost "$DOMAIN" >/dev/null 2>&1; then
  echo "==> existing cert name '$CERT_NAME' does not cover $DOMAIN; renewing"
  NEED_CERT=1
else
  echo "==> cert already covers $DOMAIN at /etc/letsencrypt/live/$CERT_NAME"
fi

if [ "$NEED_CERT" -eq 1 ]; then
  echo "==> preparing nginx ACME challenge route"
  render_dev_anywhere_nginx_challenge_conf "$DOMAIN" > "$NGINX_SITE_PATH"
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl restart nginx
  else
    nginx -s reload 2>/dev/null || nginx
  fi

  echo "==> requesting SSL cert for $DOMAIN (cert name: $CERT_NAME)"
  certbot certonly --webroot -w "$CERTBOT_WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@$DOMAIN" --cert-name "$CERT_NAME" --force-renewal
fi

# Step 4: write host nginx route and docker deployment manifest. No build, no Dockerfile.
echo "==> writing nginx reverse-proxy route"
render_dev_anywhere_nginx_conf "$DOMAIN" "$CERT_NAME" "$DEV_ANYWHERE_RELAY_PORT" > "$NGINX_SITE_PATH"
nginx -t
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx || systemctl restart nginx
else
  nginx -s reload 2>/dev/null || nginx
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
if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  cleanup_old_images
  echo
  echo "=== dev-anywhere deployed ==="
  echo "  Web UI:  https://$DOMAIN/"
  echo "  Health:  https://$DOMAIN/health"
  echo "  Proxy:   wss://$DOMAIN/proxy?token=$PROXY_TOKEN"
  echo "  Client:  wss://$DOMAIN/client?token=$CLIENT_TOKEN"
  echo "  Client token for Settings -> Relay Token: $CLIENT_TOKEN"
  echo
  echo "Next, on your local machine:"
  echo "  npm install -g @dev-anywhere/proxy"
  echo "  dev-anywhere init"
  echo "  # edit ~/.dev-anywhere/config.json:"
  echo "  #   { \"defaultProfile\": \"default\", \"profiles\": { \"default\": { \"relay\": \"cloud\" } }, \"relays\": { \"cloud\": { \"url\": \"wss://$DOMAIN\", \"proxyToken\": \"$PROXY_TOKEN\" } } }"
  echo "  dev-anywhere serve start --relay cloud"
  echo
  echo "Open the Web UI URL above once. The client token is stored in local browser storage for future launches."
  echo
  echo "To upgrade later:"
  echo "  sudo env IMAGE_TAG=$IMAGE_TAG ./scripts/deploy/install-relay.sh $DOMAIN"
else
  echo "error: health check failed; run 'docker compose logs' in $INSTALL_DIR to investigate" >&2
  exit 1
fi
