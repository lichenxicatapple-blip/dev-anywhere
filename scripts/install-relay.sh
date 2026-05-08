#!/usr/bin/env bash
# Deploy dev-anywhere (relay + web) on a VPS using pre-built images from GHCR.
#
# Two modes:
#
#   1) Run from your laptop; auto-ssh into a remote VPS and deploy there:
#        ./install-relay.sh --ssh user@vps-host dev-anywhere.vita-tools.top
#      Requires ssh-key access to the remote host and sudo for that user.
#
#   2) Run directly on the VPS:
#        sudo ./install-relay.sh dev-anywhere.vita-tools.top
#      Or:
#        curl -fsSL https://.../install-relay.sh | sudo bash -s -- dev-anywhere.vita-tools.top
#
# Arguments:
#   domain — public DNS name with an A record pointing at the VPS.
#   token  — optional; a fresh RELAY_PROXY_TOKEN is generated when omitted.
#
# Environment overrides:
#   REGISTRY_BASE — registry + namespace prefix for the images
#                   (default: ghcr.io/lichenxicatapple-blip).
#                   For China VPSes use the Aliyun ACR personal instance
#                   bound to this project (personal instances have a unique
#                   instance-id prefix and require `docker login` on the VPS):
#                   crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip
#                   Verify the exact URL in Aliyun console → Container Registry
#                   → 实例 → 访问凭证; don't assume cn-hangzhou or the shared
#                   `registry.cn-*.aliyuncs.com` URL — personal ACR is different.
#   IMAGE_TAG     — image tag to pull (default: latest).
#
# Layout created on the VPS:
#   /opt/dev-anywhere/
#     ├─ docker-compose.yml
#     └─ .env                # RELAY_PROXY_TOKEN, chmod 600
#
# Two services come up: `relay` (Node WebSocket server) and `nginx` (reverse
# proxy + static web SPA). TLS certs live under /etc/letsencrypt/live/relay/
# and are auto-renewed by the host's certbot cron job.
#
set -euo pipefail

# --ssh mode: feed this very script over stdin to a remote bash.
if [ "${1:-}" = "--ssh" ]; then
  shift
  SSH_HOST="${1:?Usage: install-relay.sh --ssh <ssh-host> <domain> [token]}"
  DOMAIN_ARG="${2:?Usage: install-relay.sh --ssh <ssh-host> <domain> [token]}"
  TOKEN_ARG="${3:-}"
  SELF_PATH="${BASH_SOURCE[0]}"
  if [ ! -f "$SELF_PATH" ]; then
    echo "error: --ssh mode needs the script on disk (can't pipe from curl)" >&2
    exit 1
  fi
  echo "==> deploying to $SSH_HOST (domain: $DOMAIN_ARG)"
  # sudo strips env vars; use `sudo env VAR=val` to thread REGISTRY_BASE / IMAGE_TAG through
  ssh -t "$SSH_HOST" "sudo env REGISTRY_BASE='${REGISTRY_BASE:-}' IMAGE_TAG='${IMAGE_TAG:-}' bash -s -- '$DOMAIN_ARG' '$TOKEN_ARG'" < "$SELF_PATH"
  exit $?
fi

DOMAIN="${1:?Usage: install-relay.sh <domain> [token]  |  install-relay.sh --ssh <host> <domain>}"
TOKEN="${2:-}"
INSTALL_DIR="/opt/dev-anywhere"
CERT_NAME="relay"   # baked into apps/relay/nginx.conf; keep in sync
# REGISTRY_BASE is the "registry/namespace" prefix. Override to pull from the
# Aliyun ACR personal instance (requires `docker login` on the VPS first):
#   REGISTRY_BASE=crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip
REGISTRY_BASE="${REGISTRY_BASE:-ghcr.io/lichenxicatapple-blip}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
RELAY_IMAGE="${REGISTRY_BASE}/dev-anywhere-relay:${IMAGE_TAG}"
WEB_IMAGE="${REGISTRY_BASE}/dev-anywhere-web:${IMAGE_TAG}"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

echo "==> domain:       $DOMAIN"
echo "==> install dir:  $INSTALL_DIR"
echo "==> relay image:  $RELAY_IMAGE"
echo "==> web image:    $WEB_IMAGE"

# Step 1: install docker if missing.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose v2 is required" >&2
  exit 1
fi

# Step 2: install certbot if missing.
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> installing certbot"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y certbot
  elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release && yum install -y certbot
  else
    echo "error: unsupported distro (need apt-get or yum)" >&2
    exit 1
  fi
fi

# Step 3: obtain the SSL certificate via certbot standalone.
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
  echo "==> requesting SSL cert for $DOMAIN (cert name: $CERT_NAME)"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    (cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true)
  fi
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@$DOMAIN" --cert-name "$CERT_NAME" --force-renewal
fi

# Step 4: write the deployment manifest. No build, no Dockerfile.
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

cat > docker-compose.yml <<EOF
services:
  relay:
    image: $RELAY_IMAGE
    container_name: dev-anywhere-relay
    restart: unless-stopped
    env_file: .env
    expose: ["3100"]
    volumes:
      - relay-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3100/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  nginx:
    image: $WEB_IMAGE
    container_name: dev-anywhere-nginx
    restart: unless-stopped
    depends_on:
      relay:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - /var/www/certbot:/var/www/certbot:ro

volumes:
  relay-data:
EOF

# Step 5: reuse or generate the proxy token.
if [ -z "$TOKEN" ]; then
  if [ -f .env ] && grep -q '^RELAY_PROXY_TOKEN=' .env; then
    TOKEN=$(grep '^RELAY_PROXY_TOKEN=' .env | cut -d= -f2-)
    echo "==> reusing existing RELAY_PROXY_TOKEN from $INSTALL_DIR/.env"
  else
    TOKEN=$(openssl rand -hex 24)
    echo "==> generated a new RELAY_PROXY_TOKEN"
  fi
fi
umask 077
cat > .env <<EOF
RELAY_PROXY_TOKEN=$TOKEN
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

# Step 7: verify.
sleep 3
if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo
  echo "=== dev-anywhere deployed ==="
  echo "  Web UI:  https://$DOMAIN"
  echo "  Health:  https://$DOMAIN/health"
  echo "  Proxy:   wss://$DOMAIN/proxy?token=$TOKEN"
  echo "  Client:  wss://$DOMAIN/client"
  echo
  echo "Next, on your local machine:"
  echo "  npm install -g @dev-anywhere/proxy"
  echo "  dev-anywhere init"
  echo "  # edit ~/.dev-anywhere/config.json:"
  echo "  #   { \"defaultEnv\": \"cloud\", \"envs\": { \"cloud\": { \"relayUrl\": \"wss://$DOMAIN\", \"relayToken\": \"$TOKEN\" } } }"
  echo "  dev-anywhere serve start --env cloud"
  echo
  echo "To upgrade later:"
  echo "  cd $INSTALL_DIR && docker compose pull && docker compose up -d"
else
  echo "error: health check failed; run 'docker compose logs' in $INSTALL_DIR to investigate" >&2
  exit 1
fi
