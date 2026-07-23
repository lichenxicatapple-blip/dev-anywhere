#!/usr/bin/env bash

dev_anywhere_is_ipv4_address() {
  local candidate="$1"
  local first second third fourth octet

  [[ "$candidate" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r first second third fourth <<< "$candidate"
  for octet in "$first" "$second" "$third" "$fourth"; do
    ((10#$octet >= 0 && 10#$octet <= 255)) || return 1
  done
}

dev_anywhere_is_domain_name() {
  local candidate="$1"
  local label last_label
  local labels=()

  ((${#candidate} > 0 && ${#candidate} <= 253)) || return 1
  [[ "$candidate" =~ ^[A-Za-z0-9.-]+$ ]] || return 1
  [[ "$candidate" != .* && "$candidate" != *. && "$candidate" != *..* ]] || return 1

  IFS=. read -r -a labels <<< "$candidate"
  ((${#labels[@]} >= 2)) || return 1
  for label in "${labels[@]}"; do
    ((${#label} > 0 && ${#label} <= 63)) || return 1
    [[ "$label" != -* && "$label" != *- ]] || return 1
  done

  last_label="${labels[${#labels[@]} - 1]}"
  [[ "$last_label" =~ [A-Za-z] ]]
}

dev_anywhere_public_host_kind() {
  local public_host="$1"

  if dev_anywhere_is_ipv4_address "$public_host"; then
    printf 'ip\n'
  elif dev_anywhere_is_domain_name "$public_host"; then
    printf 'domain\n'
  else
    return 1
  fi
}

dev_anywhere_certbot_supports_ip_certificates() {
  local version="${1#certbot }"
  local major minor

  version="${version%% *}"
  major="${version%%.*}"
  version="${version#*.}"
  minor="${version%%.*}"

  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  ((major > 5 || (major == 5 && minor >= 4)))
}

request_dev_anywhere_certificate() {
  local certbot_bin="$1"
  local target_kind="$2"
  local public_host="$3"
  local certbot_webroot="$4"
  local cert_name="$5"
  local certbot_config_dir="${6:-}"
  local certbot_work_dir="${7:-}"
  local certbot_logs_dir="${8:-}"

  if [ "$target_kind" = "ip" ]; then
    "$certbot_bin" certonly \
      --config-dir "$certbot_config_dir" \
      --work-dir "$certbot_work_dir" \
      --logs-dir "$certbot_logs_dir" \
      --preferred-profile shortlived \
      --webroot \
      --webroot-path "$certbot_webroot" \
      --ip-address "$public_host" \
      --non-interactive \
      --agree-tos \
      --register-unsafely-without-email \
      --cert-name "$cert_name" \
      --force-renewal
    return
  fi

  "$certbot_bin" certonly \
    --webroot \
    --webroot-path "$certbot_webroot" \
    -d "$public_host" \
    --non-interactive \
    --agree-tos \
    --email "admin@$public_host" \
    --cert-name "$cert_name" \
    --force-renewal
}

render_dev_anywhere_certbot_deploy_hook() {
  cat <<'EOF'
#!/bin/sh
if ! nginx -t >/dev/null 2>&1; then
  nginx -t
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload nginx || systemctl restart nginx
else
  nginx -s reload
fi
EOF
}

render_dev_anywhere_certbot_renew_service() {
  local certbot_bin="$1"
  local certbot_config_dir="$2"
  local certbot_work_dir="$3"
  local certbot_logs_dir="$4"
  local cert_name="$5"

  cat <<EOF
[Unit]
Description=Renew DEV Anywhere public IP certificate

[Service]
Type=oneshot
ExecStart=$certbot_bin renew --quiet --no-random-sleep-on-renew --config-dir $certbot_config_dir --work-dir $certbot_work_dir --logs-dir $certbot_logs_dir --cert-name $cert_name
EOF
}

render_dev_anywhere_certbot_renew_timer() {
  cat <<'EOF'
[Unit]
Description=Renew DEV Anywhere public IP certificate twice daily

[Timer]
OnActiveSec=12h
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

render_dev_anywhere_certbot_renew_cron() {
  local certbot_bin="$1"
  local certbot_config_dir="$2"
  local certbot_work_dir="$3"
  local certbot_logs_dir="$4"
  local cert_name="$5"

  printf '17 */12 * * * root %s renew --quiet --no-random-sleep-on-renew --config-dir %s --work-dir %s --logs-dir %s --cert-name %s\n' \
    "$certbot_bin" \
    "$certbot_config_dir" \
    "$certbot_work_dir" \
    "$certbot_logs_dir" \
    "$cert_name"
}

render_dev_anywhere_compose() {
  local relay_image="$1"
  local relay_port="$2"

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

volumes:
  relay-data:
EOF
}

render_dev_anywhere_nginx_challenge_conf() {
  local public_host="$1"

  cat <<EOF
server {
    listen 80;
    server_name $public_host;

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
  local public_host="$1"
  local cert_name="$2"
  local relay_port="$3"
  local cert_live_root="${4:-/etc/letsencrypt/live}"
  local https_listen="listen 443 ssl http2;"

  if dev_anywhere_is_ipv4_address "$public_host"; then
    https_listen="listen 443 ssl http2 default_server;"
  fi

  cat <<EOF
server {
    listen 80;
    server_name $public_host;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    $https_listen
    server_name $public_host;

    ssl_certificate $cert_live_root/$cert_name/fullchain.pem;
    ssl_certificate_key $cert_live_root/$cert_name/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 20m;

    location ~ ^/(proxy|client|voice/asr|voice/tts)$ {
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

    location ^~ /api/remote-uploads/ {
        proxy_pass http://127.0.0.1:$relay_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location / {
        proxy_pass http://127.0.0.1:$relay_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
}
