#!/usr/bin/env bash

render_dev_anywhere_compose() {
  local relay_image="$1"
  local web_image="$2"
  local relay_port="$3"
  local web_port="$4"

  cat <<EOF
services:
  relay:
    image: $relay_image
    container_name: dev-anywhere-relay
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:$relay_port:3100"
    volumes:
      - relay-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3100/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  web:
    image: $web_image
    container_name: dev-anywhere-web
    restart: unless-stopped
    depends_on:
      relay:
        condition: service_healthy
    ports:
      - "127.0.0.1:$web_port:80"

volumes:
  relay-data:
EOF
}

render_dev_anywhere_nginx_challenge_conf() {
  local domain="$1"

  cat <<EOF
server {
    listen 80;
    server_name $domain;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 404;
    }
}
EOF
}

render_dev_anywhere_nginx_conf() {
  local domain="$1"
  local cert_name="$2"
  local relay_port="$3"
  local web_port="$4"

  cat <<EOF
server {
    listen 80;
    server_name $domain;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name $domain;

    ssl_certificate /etc/letsencrypt/live/$cert_name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$cert_name/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 20m;

    location ~ ^/(proxy|client)$ {
        proxy_pass http://127.0.0.1:$relay_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    location ~ ^/(fonts|health|status|api)(/.*)?$ {
        proxy_pass http://127.0.0.1:$relay_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:$web_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
}
