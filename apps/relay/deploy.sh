#!/usr/bin/env bash
set -euo pipefail

# CC Anywhere Relay Server deployment script
# Usage: ./deploy.sh <ssh-host> [domain]
# Example: ./deploy.sh ubuntu@1.2.3.4 relay.example.com

SSH_HOST="${1:?Usage: ./deploy.sh <ssh-host> [domain]}"
DOMAIN="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Detect if we need sudo (non-root user)
SUDO=""
REMOTE_USER=$(ssh "$SSH_HOST" 'whoami')
if [ "$REMOTE_USER" != "root" ]; then
  SUDO="sudo"
fi

echo "=== CC Anywhere Relay Deployment ==="
echo "Target: $SSH_HOST (user: $REMOTE_USER)"
echo "Domain: ${DOMAIN:-not set}"
echo ""

# Step 1: Install Docker
echo "[1/6] Checking Docker on remote server..."
ssh "$SSH_HOST" "${SUDO} sh -c 'command -v docker >/dev/null 2>&1 && echo \"Docker already installed\" || {
  echo \"Installing Docker...\"

  # Detect distro and install accordingly
  if command -v apt-get >/dev/null 2>&1; then
    # Ubuntu/Debian
    apt-get update -qq
    apt-get install -y ca-certificates curl gnupg

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable\" > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

  elif command -v dnf >/dev/null 2>&1; then
    # CentOS/RHEL/TencentOS
    dnf install -y dnf-plugins-core 2>/dev/null || true
    dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo 2>/dev/null || true
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi

  # Docker Hub mirror for China mainland
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<DOCKER_EOF
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.mirrors.ustc.edu.cn"
  ]
}
DOCKER_EOF

  systemctl enable docker
  systemctl start docker
  echo \"Docker installed\"
}'"

# Step 2: Verify docker compose plugin
echo "[2/6] Verifying docker compose..."
ssh "$SSH_HOST" "${SUDO} docker --version && ${SUDO} docker compose version"

# Add current user to docker group so subsequent commands don't need sudo
if [ "$REMOTE_USER" != "root" ]; then
  ssh "$SSH_HOST" "${SUDO} usermod -aG docker ${REMOTE_USER} 2>/dev/null || true"
fi

# Step 3: SSL certificate setup
if [ -n "$DOMAIN" ]; then
  echo "[3/6] Setting up SSL certificate for $DOMAIN..."
  ssh "$SSH_HOST" "${SUDO} sh -c '
    command -v certbot >/dev/null 2>&1 || {
      apt-get install -y certbot 2>/dev/null || yum install -y epel-release certbot 2>/dev/null
    }
    if [ ! -d /etc/letsencrypt/live/relay ]; then
      systemctl stop nginx 2>/dev/null || true
      certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN \
        --cert-name relay
    else
      echo \"Certificate already exists\"
    fi
  '"
else
  echo "[3/6] Skipping SSL setup (no domain provided)"
fi

# Step 4: Sync project files to server (tar + scp, faster than rsync for bulk transfer)
echo "[4/6] Syncing project files..."
REMOTE_DIR="/opt/cc-anywhere"
ssh "$SSH_HOST" "${SUDO} mkdir -p $REMOTE_DIR && ${SUDO} chown ${REMOTE_USER}:${REMOTE_USER} $REMOTE_DIR"

TMPFILE=$(mktemp /tmp/cc-anywhere-deploy.XXXXXX.tar.gz)
echo "  Packing project files..."
tar czf "$TMPFILE" -C "$PROJECT_ROOT" \
  --no-xattrs \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.git \
  --exclude=.planning \
  --exclude=.claude \
  --exclude=.playwright-mcp \
  --exclude=reference \
  .
echo "  Uploading $(du -h "$TMPFILE" | cut -f1)..."
scp -q "$TMPFILE" "$SSH_HOST:/tmp/cc-anywhere-deploy.tar.gz"
ssh "$SSH_HOST" "cd $REMOTE_DIR && rm -rf ./* && tar xzf /tmp/cc-anywhere-deploy.tar.gz && rm /tmp/cc-anywhere-deploy.tar.gz"
rm -f "$TMPFILE"

# Step 5: Build and start
echo "[5/6] Building and starting relay server..."
ssh "$SSH_HOST" "
  cd $REMOTE_DIR
  ${SUDO} docker compose -f apps/relay/docker-compose.yml down 2>/dev/null || true
  ${SUDO} docker compose -f apps/relay/docker-compose.yml build --no-cache
  ${SUDO} docker compose -f apps/relay/docker-compose.yml up -d
"

# Step 6: Health check
echo "[6/6] Checking health..."
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
echo "Status: curl http://<server-ip>:3100/status"
echo "Logs:   ssh $SSH_HOST '${SUDO} docker compose -f /opt/cc-anywhere/apps/relay/docker-compose.yml logs -f relay'"
