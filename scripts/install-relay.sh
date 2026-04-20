#!/usr/bin/env bash
# 一键部署 cc-anywhere-relay (docker + nginx + Let's Encrypt TLS)
# 支持两种运行方式:
#
#   1) 本地跑, 自动 SSH 到远程 VPS 部署 (推荐, 不用登录 VPS):
#        ./install-relay.sh --ssh user@vps-host  cc-anywhere.example.com
#        本机只需 ssh-key 能登上远程且远程用户有 sudo 权限
#
#   2) 已经在 VPS 上跑:
#        sudo ./install-relay.sh cc-anywhere.example.com
#      或
#        curl -fsSL https://.../install-relay.sh | sudo bash -s -- cc-anywhere.example.com
#
# 参数:
#   domain — 公网域名, 需已 A 记录到 VPS IP
#   token  — 可选; 不传则随机生成, 部署完打印出来
#
# 产物 (在 VPS 上):
#   /opt/cc-anywhere-relay/
#     ├─ docker-compose.yml
#     ├─ nginx.conf
#     ├─ Dockerfile                 (npm i -g cc-anywhere-relay@latest 起容器)
#     └─ .env                       (含 RELAY_PROXY_TOKEN, chmod 600)
#
set -euo pipefail

# --- 远程模式: 本地执行, 把脚本自身喂给远程 bash ---------------------------
# 检测到 --ssh 时先走这个分支, 然后把原脚本从 stdin 喂过去; 远程执行时不会命中本分支
if [ "${1:-}" = "--ssh" ]; then
  shift
  SSH_HOST="${1:?Usage: install-relay.sh --ssh <ssh-host> <domain> [token]}"
  DOMAIN_ARG="${2:?Usage: install-relay.sh --ssh <ssh-host> <domain> [token]}"
  TOKEN_ARG="${3:-}"
  SELF_PATH="${BASH_SOURCE[0]}"
  if [ ! -f "$SELF_PATH" ]; then
    echo "error: --ssh mode requires script file on disk (can't pipe from curl)" >&2
    exit 1
  fi
  echo "==> deploying to $SSH_HOST (domain: $DOMAIN_ARG)"
  # -t 分配 tty 让远程 sudo 能交互拿密码 (如果需要); stdin 喂脚本内容
  ssh -t "$SSH_HOST" "sudo bash -s -- '$DOMAIN_ARG' '$TOKEN_ARG'" < "$SELF_PATH"
  exit $?
fi

# --- 本地 VPS 模式: 所有重头戏从这里开始 ------------------------------------
DOMAIN="${1:?Usage: install-relay.sh <domain> [token]  或  install-relay.sh --ssh <host> <domain>}"
TOKEN="${2:-}"
INSTALL_DIR="/opt/cc-anywhere-relay"
CERT_NAME="cc-anywhere-relay"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo)" >&2
  exit 1
fi

echo "==> domain: $DOMAIN"
echo "==> install dir: $INSTALL_DIR"

# 1) 装 docker (if missing)
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose v2 not available" >&2
  exit 1
fi

# 2) 装 certbot (if missing)
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> installing certbot"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y certbot
  elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release && yum install -y certbot
  else
    echo "error: unsupported distro (need apt or yum)" >&2
    exit 1
  fi
fi

# 3) 申 SSL 证书
if [ ! -d "/etc/letsencrypt/live/$CERT_NAME" ]; then
  echo "==> requesting SSL cert for $DOMAIN"
  # 先 down 任何可能占 80 端口的旧 stack
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    (cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true)
  fi
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@$DOMAIN" --cert-name "$CERT_NAME"
else
  echo "==> cert already exists at /etc/letsencrypt/live/$CERT_NAME"
fi

# 4) 生成工作目录
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Dockerfile: 干净的 alpine + 从 npm 装最新 relay
cat > Dockerfile <<'EOF'
FROM node:22-alpine
WORKDIR /app
RUN npm install -g cc-anywhere-relay@latest
ENV NODE_ENV=production
EXPOSE 3100
CMD ["cc-anywhere-relay"]
EOF

# nginx.conf: HTTP→HTTPS + WSS /proxy /client + HTTP /health /status
cat > nginx.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Let's Encrypt HTTP-01 renewal
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$CERT_NAME/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$CERT_NAME/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # WebSocket endpoints → relay container
    location /proxy {
        proxy_pass http://relay:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }
    location /client {
        proxy_pass http://relay:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }

    # HTTP endpoints
    location = /health   { proxy_pass http://relay:3100/health; }
    location = /status   { proxy_pass http://relay:3100/status; }

    # 其他路径返回 404; 如果需要跟 Web SPA 一起托管自行扩
    location / {
        return 404;
    }
}
EOF

# docker-compose.yml
cat > docker-compose.yml <<'EOF'
services:
  relay:
    build: .
    container_name: cc-anywhere-relay
    restart: unless-stopped
    env_file: .env
    volumes:
      - relay-data:/root/.cc-anywhere/relay-data

  nginx:
    image: nginx:alpine
    container_name: cc-anywhere-nginx
    restart: unless-stopped
    depends_on: [relay]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - /var/www/certbot:/var/www/certbot:ro

volumes:
  relay-data:
EOF

# 5) 复用 / 生成 token
if [ -z "$TOKEN" ]; then
  if [ -f .env ] && grep -q '^RELAY_PROXY_TOKEN=' .env; then
    TOKEN=$(grep '^RELAY_PROXY_TOKEN=' .env | cut -d= -f2-)
    echo "==> reusing existing RELAY_PROXY_TOKEN from $INSTALL_DIR/.env"
  else
    TOKEN=$(openssl rand -hex 24)
    echo "==> generated new RELAY_PROXY_TOKEN"
  fi
fi
umask 077
cat > .env <<EOF
RELAY_PROXY_TOKEN=$TOKEN
PORT=3100
EOF
chmod 600 .env

# 6) 起容器
echo "==> building + starting"
docker compose up -d --build

# 7) 验证
sleep 3
if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo
  echo "=== Relay deployed ==="
  echo "  Health:  https://$DOMAIN/health"
  echo "  Proxy:   wss://$DOMAIN/proxy?token=$TOKEN"
  echo "  Client:  wss://$DOMAIN/client"
  echo
  echo "On your local machine:"
  echo "  npm install -g cc-anywhere"
  echo "  mkdir -p ~/.cc-anywhere"
  echo "  cat > ~/.cc-anywhere/config.json <<EOF"
  echo "  { \"relayUrl\": \"wss://$DOMAIN\", \"relayToken\": \"$TOKEN\" }"
  echo "  EOF"
  echo "  cc-anywhere serve start"
else
  echo "error: health check failed; check 'docker compose logs'" >&2
  exit 1
fi
