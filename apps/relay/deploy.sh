#!/usr/bin/env bash
set -euo pipefail

# CC Anywhere Relay Server deployment script
# Usage: ./deploy.sh <ssh-host> [domain]
# Example: ./deploy.sh root@1.2.3.4 relay.example.com

SSH_HOST="${1:?Usage: ./deploy.sh <ssh-host> [domain]}"
DOMAIN="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== CC Anywhere Relay Deployment ==="
echo "Target: $SSH_HOST"
echo "Domain: ${DOMAIN:-not set}"
echo ""

# Step 1: Check Docker on remote server
echo "[1/5] Checking Docker on remote server..."
ssh "$SSH_HOST" 'command -v docker >/dev/null 2>&1 || {
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "Docker installed"
}'

# Step 2: Verify docker compose plugin
ssh "$SSH_HOST" 'docker compose version >/dev/null 2>&1 || {
  echo "ERROR: docker compose plugin not available"
  exit 1
}'

# Step 3: SSL certificate setup
if [ -n "$DOMAIN" ]; then
  echo "[2/5] Setting up SSL certificate for $DOMAIN..."
  ssh "$SSH_HOST" "
    command -v certbot >/dev/null 2>&1 || {
      yum install -y epel-release
      yum install -y certbot
    }
    if [ ! -d /etc/letsencrypt/live/relay ]; then
      certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN \
        --cert-name relay
    else
      echo 'Certificate already exists'
    fi
  "
else
  echo "[2/5] Skipping SSL setup (no domain provided)"
fi

# Step 4: Sync project files to server
echo "[3/5] Syncing project files..."
REMOTE_DIR="/opt/cc-anywhere"
ssh "$SSH_HOST" "mkdir -p $REMOTE_DIR"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .planning \
  --exclude .claude \
  --exclude .playwright-mcp \
  "$PROJECT_ROOT/" "$SSH_HOST:$REMOTE_DIR/"

# Step 5: Build and start
echo "[4/5] Building and starting relay server..."
ssh "$SSH_HOST" "
  cd $REMOTE_DIR
  docker compose -f apps/relay/docker-compose.yml build --no-cache
  docker compose -f apps/relay/docker-compose.yml up -d
"

# Step 6: Health check
echo "[5/5] Checking health..."
sleep 5
ssh "$SSH_HOST" "curl -sf http://localhost:3100/health" && echo " - Relay healthy" || echo " - Relay not yet ready (may need a moment)"

echo ""
echo "=== Deployment complete ==="
if [ -n "$DOMAIN" ]; then
  echo "Relay URL: wss://$DOMAIN"
else
  echo "Relay URL: ws://<server-ip>:3100 (no TLS)"
fi
echo "Health: curl http://<server-ip>:3100/health"
echo "Logs:   ssh $SSH_HOST 'docker compose -f /opt/cc-anywhere/apps/relay/docker-compose.yml logs -f relay'"
