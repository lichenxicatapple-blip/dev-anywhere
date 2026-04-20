#!/usr/bin/env bash
set -euo pipefail

# CC Anywhere deployment script (relay + web SPA + nginx)
# Usage: ./deploy.sh <ssh-host> <domain>
# Example: ./deploy.sh ubuntu@1.2.3.4 relay.example.com

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

# Step 6: 写入 .env (含 token)
echo "[6/8] Writing .env..."
ssh "$SSH_HOST" "cat > $REMOTE_DIR/.env <<EOF
RELAY_PROXY_TOKEN=$TOKEN
EOF
chmod 600 $REMOTE_DIR/.env"

# 同步字体到 relay-data named volume, 映射到容器 /data/fonts 供 relay 的 /fonts 端点服务
# volume 不存在时跳过, compose up 创建后再补 (下方 Step 7 之后)
ssh "$SSH_HOST" "
  VOL_MOUNT=\$(${SUDO} docker volume inspect relay_relay-data --format '{{.Mountpoint}}' 2>/dev/null || echo '')
  if [ -n \"\$VOL_MOUNT\" ] && [ -d $REMOTE_DATA_DIR/fonts ]; then
    ${SUDO} mkdir -p \$VOL_MOUNT/fonts
    ${SUDO} cp -rn $REMOTE_DATA_DIR/fonts/* \$VOL_MOUNT/fonts/ 2>/dev/null || true
  fi
"

# Step 7: 构建并启动
# 预拉 base image: daemon.json 的 registry-mirrors 对 pull 生效, 对 buildkit load metadata 无效
echo "[7/8] Building and starting services..."
ssh "$SSH_HOST" "
  cd $REMOTE_DIR
  ${SUDO} docker pull node:22-alpine
  ${SUDO} docker pull nginx:alpine
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml down 2>/dev/null || true
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml build
  ${SUDO} docker compose --env-file .env -f apps/relay/docker-compose.yml up -d
"

# 启动后同步字体到 volume (首次部署 volume 刚由 compose up 创建时用)
ssh "$SSH_HOST" "
  VOL_MOUNT=\$(${SUDO} docker volume inspect relay_relay-data --format '{{.Mountpoint}}' 2>/dev/null || echo '')
  if [ -n \"\$VOL_MOUNT\" ] && [ -d $REMOTE_DATA_DIR/fonts ]; then
    ${SUDO} mkdir -p \$VOL_MOUNT/fonts
    ${SUDO} cp -rn $REMOTE_DATA_DIR/fonts/* \$VOL_MOUNT/fonts/ 2>/dev/null || true
  fi
"

# Step 8: 公网连通性验证
# --noproxy 绕过本机 HTTP_PROXY; WS 用 --http1.1 (HTTP/2 协议层不支持 Upgrade 头)
echo "[8/8] Verifying deployment..."
sleep 5

CURL_COMMON=(--noproxy '*' --max-time 10)
WS_HEADERS=(-H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")

PASS=0; FAIL=0
# 对比 %{http_code} 判定成功, curl 退出码被 `|| true` 吃掉 (WS 101 后 --max-time 会触发非 0)
# 空数组展开用 ${arr[@]+...} 条件形式, 避免 set -u 报 unbound variable
check_http() {
  local label="$1" expect="$2" url="$3" http_ver="${4:-}"
  local version_flag=()
  [ -n "$http_ver" ] && version_flag=("--$http_ver")
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    "${CURL_COMMON[@]}" \
    ${version_flag[@]+"${version_flag[@]}"} \
    "${@:5}" \
    "$url" 2>/dev/null || true)
  if [ "$code" = "$expect" ]; then
    echo "  [OK]   $label ($code)"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $label (got $code, want $expect) [$url]"
    FAIL=$((FAIL+1))
  fi
}

check_http "HTTPS health endpoint"          200 "https://$DOMAIN/health"
check_http "HTTPS web index returns 200"    200 "https://$DOMAIN/"
check_http "HTTP -> HTTPS redirect"         301 "http://$DOMAIN/"
check_http "WSS /client handshake"          101 "https://$DOMAIN/client"           http1.1 "${WS_HEADERS[@]}"
check_http "WSS /proxy rejects without token" 401 "https://$DOMAIN/proxy"           http1.1 "${WS_HEADERS[@]}"
check_http "WSS /proxy accepts with token"  101 "https://$DOMAIN/proxy?token=$TOKEN" http1.1 "${WS_HEADERS[@]}"

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
echo "  RELAY_URL='wss://$DOMAIN/proxy?token=$TOKEN' pnpm --filter @lichenxi.cat/cc-anywhere run serve"
echo ""
echo "Token stored on remote in $REMOTE_DIR/.env (chmod 600)"
