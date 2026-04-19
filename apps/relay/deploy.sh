#!/usr/bin/env bash
set -euo pipefail

# CC Anywhere deployment script (relay + web SPA + nginx)
# Usage: ./deploy.sh <ssh-host> <domain>
# Example: ./deploy.sh ubuntu@1.2.3.4 vita-tools.top

SSH_HOST="${1:?Usage: ./deploy.sh <ssh-host> <domain>}"
DOMAIN="${2:?Usage: ./deploy.sh <ssh-host> <domain>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCAL_FONTS_DIR="${HOME}/.cc-anywhere/relay-data/fonts"
REMOTE_DIR="/opt/cc-anywhere"
REMOTE_DATA_DIR="/opt/cc-anywhere-data"

# 检测是否需要 sudo (非 root 用户)
SUDO=""
REMOTE_USER=$(ssh "$SSH_HOST" 'whoami')
if [ "$REMOTE_USER" != "root" ]; then
  SUDO="sudo"
fi

# Token: 从参数 / 环境变量 / 服务端已有 .env 里复用；都没有就生成一个
if [ -n "${RELAY_PROXY_TOKEN:-}" ]; then
  TOKEN="$RELAY_PROXY_TOKEN"
  echo "Using RELAY_PROXY_TOKEN from env"
else
  EXISTING=$(ssh "$SSH_HOST" "${SUDO} cat $REMOTE_DIR/.env 2>/dev/null | grep '^RELAY_PROXY_TOKEN=' | cut -d= -f2-" || true)
  if [ -n "$EXISTING" ]; then
    TOKEN="$EXISTING"
    echo "Reusing RELAY_PROXY_TOKEN from existing remote .env"
  else
    TOKEN=$(openssl rand -hex 24)
    echo "Generated new RELAY_PROXY_TOKEN"
  fi
fi

echo "=== CC Anywhere Deployment ==="
echo "Target: $SSH_HOST (user: $REMOTE_USER)"
echo "Domain: $DOMAIN"
echo ""

# Step 1: 安装 Docker
echo "[1/8] Checking Docker on remote server..."
ssh "$SSH_HOST" "${SUDO} sh -c 'command -v docker >/dev/null 2>&1 && echo \"Docker already installed\" || {
  echo \"Installing Docker...\"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable\" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y dnf-plugins-core 2>/dev/null || true
    dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo 2>/dev/null || true
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<DOCKER_EOF
{
  \"registry-mirrors\": [
    \"https://mirror.ccs.tencentyun.com\",
    \"https://docker.mirrors.ustc.edu.cn\"
  ]
}
DOCKER_EOF
  systemctl enable docker
  systemctl start docker
}'"

# Step 2: 验证 docker compose
echo "[2/8] Verifying docker compose..."
ssh "$SSH_HOST" "${SUDO} docker --version && ${SUDO} docker compose version"

if [ "$REMOTE_USER" != "root" ]; then
  ssh "$SSH_HOST" "${SUDO} usermod -aG docker ${REMOTE_USER} 2>/dev/null || true"
fi

# Step 3: SSL 证书
echo "[3/8] Setting up SSL certificate for $DOMAIN..."
ssh "$SSH_HOST" "${SUDO} sh -c '
  command -v certbot >/dev/null 2>&1 || {
    apt-get install -y certbot 2>/dev/null || yum install -y epel-release certbot 2>/dev/null
  }
  mkdir -p /var/www/certbot
  if [ ! -d /etc/letsencrypt/live/relay ]; then
    # 停掉占用 80 端口的容器 (如果有), 让 certbot standalone 能绑
    docker compose -f $REMOTE_DIR/apps/relay/docker-compose.yml down 2>/dev/null || true
    certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN \
      --cert-name relay
  else
    echo \"Certificate already exists\"
  fi
'"

# Step 4: 同步项目源码
echo "[4/8] Syncing project files..."
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

# Step 5: 同步字体 (apps/web 通过 /fonts 端点引用, relay 服务)
echo "[5/8] Syncing fonts..."
if [ -d "$LOCAL_FONTS_DIR" ]; then
  FONT_TMP=$(mktemp /tmp/cc-anywhere-fonts.XXXXXX.tar.gz)
  tar czf "$FONT_TMP" -C "$(dirname "$LOCAL_FONTS_DIR")" --no-xattrs fonts
  echo "  Uploading fonts ($(du -h "$FONT_TMP" | cut -f1))..."
  scp -q "$FONT_TMP" "$SSH_HOST:/tmp/cc-anywhere-fonts.tar.gz"
  ssh "$SSH_HOST" "
    ${SUDO} mkdir -p $REMOTE_DATA_DIR
    ${SUDO} tar xzf /tmp/cc-anywhere-fonts.tar.gz -C $REMOTE_DATA_DIR
    rm /tmp/cc-anywhere-fonts.tar.gz
  "
  rm -f "$FONT_TMP"
else
  echo "  WARN: $LOCAL_FONTS_DIR not found, skipping font sync (web will miss CJK fonts)"
fi

# Step 6: 写入 .env (含 token) + 指向数据卷
echo "[6/8] Writing .env..."
ssh "$SSH_HOST" "cat > $REMOTE_DIR/.env <<EOF
RELAY_PROXY_TOKEN=$TOKEN
EOF
chmod 600 $REMOTE_DIR/.env"

# docker-compose 里 relay 的 DATA_DIR 指 /data, 我们把本地 fonts 目录挂进去
# 修改 docker-compose.yml 的 relay-data volume 为 bind mount (让字体能看见)
# 这一步只在首次部署时做
ssh "$SSH_HOST" "
  cd $REMOTE_DIR
  # 确保 named volume 的字体数据存在 (把同步的 fonts 拷进去)
  VOL_MOUNT=\$(${SUDO} docker volume inspect relay_relay-data --format '{{.Mountpoint}}' 2>/dev/null || echo '')
  if [ -z \"\$VOL_MOUNT\" ]; then
    # 卷不存在, compose up 时会自动创建, 字体拷贝延后到启动后做
    true
  else
    ${SUDO} mkdir -p \$VOL_MOUNT/fonts
    ${SUDO} cp -rn $REMOTE_DATA_DIR/fonts/* \$VOL_MOUNT/fonts/ 2>/dev/null || true
  fi
"

# Step 7: 构建并启动
echo "[7/8] Building and starting services..."
ssh "$SSH_HOST" "
  cd $REMOTE_DIR
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml down 2>/dev/null || true
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml build --no-cache
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml up -d
"

# 启动后再保证字体进入 volume (处理首次部署 volume 刚创建的情况)
ssh "$SSH_HOST" "
  VOL_MOUNT=\$(${SUDO} docker volume inspect relay_relay-data --format '{{.Mountpoint}}' 2>/dev/null || echo '')
  if [ -n \"\$VOL_MOUNT\" ] && [ -d $REMOTE_DATA_DIR/fonts ]; then
    ${SUDO} mkdir -p \$VOL_MOUNT/fonts
    ${SUDO} cp -rn $REMOTE_DATA_DIR/fonts/* \$VOL_MOUNT/fonts/ 2>/dev/null || true
  fi
"

# Step 8: 公网连通性验证
echo "[8/8] Verifying deployment..."
sleep 5

PASS=0; FAIL=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  [OK]   $label"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $label"
    FAIL=$((FAIL+1))
  fi
}

check "HTTPS health endpoint"      curl -fsS "https://$DOMAIN/health"
check "HTTPS web index returns 200" curl -fsSI "https://$DOMAIN/"
check "HTTP -> HTTPS redirect"     sh -c "curl -s -o /dev/null -w '%{http_code}' http://$DOMAIN/ | grep -q 301"
check "WSS /client handshake"      sh -c "curl -sS -o /dev/null -w '%{http_code}' --include -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'https://$DOMAIN/client' | grep -q 101"
check "WSS /proxy rejects without token" \
  sh -c "curl -sS -o /dev/null -w '%{http_code}' --include -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'https://$DOMAIN/proxy' | grep -q 401"
check "WSS /proxy accepts with token" \
  sh -c "curl -sS -o /dev/null -w '%{http_code}' --include -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'https://$DOMAIN/proxy?token=$TOKEN' | grep -q 101"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== Deployment verified: $PASS checks passed ==="
else
  echo "=== Deployment partial: $PASS passed, $FAIL failed ==="
  echo "Logs: ssh $SSH_HOST '${SUDO} docker compose --env-file /opt/cc-anywhere/.env -f /opt/cc-anywhere/apps/relay/docker-compose.yml logs -f'"
  exit 1
fi

echo ""
echo "Web:   https://$DOMAIN"
echo "WSS:   wss://$DOMAIN/client  (open)"
echo "       wss://$DOMAIN/proxy?token=<redacted>  (token required)"
echo ""
echo "Local proxy example:"
echo "  RELAY_URL='wss://$DOMAIN/proxy?token=$TOKEN' pnpm --filter @cc-anywhere/proxy run serve"
echo ""
echo "Token stored on remote in $REMOTE_DIR/.env (chmod 600)"
