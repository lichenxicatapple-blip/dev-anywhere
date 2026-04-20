#!/usr/bin/env bash
# Deploy cc-anywhere-relay with docker + nginx + Let's Encrypt TLS.
#
# Two modes:
#
#   1) Run from your laptop; auto-ssh into a remote VPS and deploy there:
#        ./install-relay.sh --ssh user@vps-host relay.example.com
#      Requires ssh-key access to the remote host and sudo for that user.
#
#   2) Run directly on the VPS:
#        sudo ./install-relay.sh relay.example.com
#      Or:
#        curl -fsSL https://.../install-relay.sh | sudo bash -s -- relay.example.com
#
# Arguments:
#   domain — public DNS name with an A record pointing at the VPS.
#   token  — optional; a fresh RELAY_PROXY_TOKEN is generated when omitted.
#
# Layout created on the VPS:
#   /opt/cc-anywhere-relay/
#     ├─ docker-compose.yml
#     ├─ nginx.conf
#     ├─ Dockerfile          # installs cc-anywhere-relay from npm at build time
#     └─ .env                # RELAY_PROXY_TOKEN, chmod 600
#
set -euo pipefail

# --ssh mode: feed this very script over stdin to a remote bash.
# The remote invocation re-enters at the local-VPS branch below.
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
  # -t allocates a tty so remote sudo can prompt for a password if needed.
  ssh -t "$SSH_HOST" "sudo bash -s -- '$DOMAIN_ARG' '$TOKEN_ARG'" < "$SELF_PATH"
  exit $?
fi

# Local-VPS mode.
DOMAIN="${1:?Usage: install-relay.sh <domain> [token]  |  install-relay.sh --ssh <host> <domain>}"
TOKEN="${2:-}"
INSTALL_DIR="/opt/cc-anywhere-relay"
CERT_NAME="cc-anywhere-relay"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

echo "==> domain: $DOMAIN"
echo "==> install dir: $INSTALL_DIR"

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
if [ ! -d "/etc/letsencrypt/live/$CERT_NAME" ]; then
  echo "==> requesting SSL cert for $DOMAIN"
  # Free port 80 if the previous stack is up, otherwise certbot standalone fails.
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    (cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true)
  fi
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@$DOMAIN" --cert-name "$CERT_NAME"
else
  echo "==> cert already exists at /etc/letsencrypt/live/$CERT_NAME"
fi

# Step 4: write the deployment manifests.
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Dockerfile: minimal Node runtime that installs the relay from npm at build time.
cat > Dockerfile <<'EOF'
FROM node:22-alpine
WORKDIR /app
RUN npm install -g cc-anywhere-relay@latest
ENV NODE_ENV=production
EXPOSE 3100
CMD ["cc-anywhere-relay"]
EOF

# nginx.conf: HTTP->HTTPS redirect, WSS passthrough for /proxy and /client,
# HTTP passthrough for /health and /status, everything else 404.
cat > nginx.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

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

    location = /health { proxy_pass http://relay:3100/health; }
    location = /status { proxy_pass http://relay:3100/status; }

    location / {
        return 404;
    }
}
EOF

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
EOF
chmod 600 .env

# Step 6: build image and start the stack.
echo "==> building and starting containers"
docker compose up -d --build

# Step 7: verify.
sleep 3
if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo
  echo "=== Relay deployed ==="
  echo "  Health:  https://$DOMAIN/health"
  echo "  Proxy:   wss://$DOMAIN/proxy?token=$TOKEN"
  echo "  Client:  wss://$DOMAIN/client"
  echo
  echo "Next, on your local machine:"
  echo "  npm install -g cc-anywhere"
  echo "  mkdir -p ~/.cc-anywhere"
  echo "  cat > ~/.cc-anywhere/config.json <<EOF"
  echo "  { \"relayUrl\": \"wss://$DOMAIN\", \"relayToken\": \"$TOKEN\" }"
  echo "  EOF"
  echo "  cc-anywhere serve start"
else
  echo "error: health check failed; run 'docker compose logs' in $INSTALL_DIR to investigate" >&2
  exit 1
fi
