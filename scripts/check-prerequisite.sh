#!/usr/bin/env bash
# 在跑 install-relay.sh 之前 dry-run 检查目标 VPS 是否就绪. 不修改任何东西, 只报告.
# 检查项来自 v0.2.4 切阿里云时实地撞过的坑:
#   1. SSH 可用性 + host key (旧机器重装会导致本地 known_hosts 残留)
#   2. SSH 用户 (阿里云 Ubuntu 默认 root, 项目 ssh config 之前用 ubuntu)
#   3. docker / docker compose v2
#   4. apt-get 或 yum (certbot 安装会用到)
#   5. 80 / 443 端口入方向 (LE HTTP-01 challenge 需要 80 公网可达)
#   6. 域名 DNS A 记录是否解析到当前 VPS IP
#
# 用法:
#   bash scripts/check-prerequisite.sh <ssh-host> <domain>
#   例: bash scripts/check-prerequisite.sh root@1.2.3.4 dev-anywhere.example.com
set -euo pipefail

SSH_HOST="${1:?Usage: check-prerequisite.sh <ssh-host> <domain>}"
DOMAIN="${2:?Usage: check-prerequisite.sh <ssh-host> <domain>}"

PASS=0
FAIL=0
WARN=0

ok()   { echo "  OK   $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL+1)); }
warn() { echo "  WARN $1" >&2; WARN=$((WARN+1)); }

section() { echo ""; echo "=== $1 ==="; }

section "Local DNS resolution for $DOMAIN"
if RESOLVED_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')" && [ -n "$RESOLVED_IP" ]; then
  ok "$DOMAIN resolves to $RESOLVED_IP"
elif RESOLVED_IP="$(dig +short "$DOMAIN" A 2>/dev/null | tail -1)" && [ -n "$RESOLVED_IP" ]; then
  ok "$DOMAIN resolves to $RESOLVED_IP (via dig)"
else
  fail "$DOMAIN does not resolve. 切换 VPS 后域名 A 记录指过来了吗?"
  RESOLVED_IP=""
fi

section "SSH reachability + host key"
if SSH_TARGET_IP="$(ssh -G "$SSH_HOST" 2>/dev/null | awk '/^hostname /{print $2}')"; then
  ok "ssh config resolves $SSH_HOST → $SSH_TARGET_IP"
else
  warn "无法从 ssh -G 解析 $SSH_HOST 主机, 后续可能直连域名"
  SSH_TARGET_IP=""
fi

KNOWN_HOSTS_LINE="$(ssh-keygen -F "$SSH_HOST" 2>/dev/null | head -1 || true)"
if [ -n "$KNOWN_HOSTS_LINE" ]; then
  ok "$SSH_HOST 已在 known_hosts 内"
fi

if SSH_USER="$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" "id -un" 2>&1)" && [ "${SSH_USER:0:1}" != " " ]; then
  ok "SSH 公钥认证通过, 远端 user=$SSH_USER"
else
  fail "SSH 公钥认证失败. ${SSH_USER}"
  fail "  → 阿里云控制台导入公钥并绑定实例, 或 Workbench 进 vps 把公钥追加到 ~/.ssh/authorized_keys"
  echo ""
  echo "Summary: $PASS passed, $FAIL failed, $WARN warnings"
  exit 1
fi

section "Remote prerequisites on $SSH_HOST"
REMOTE_PROBE="$(ssh -o BatchMode=yes "$SSH_HOST" "
  echo USER=\$(id -un)
  echo OS=\$(. /etc/os-release && echo \"\$ID \$VERSION_ID\")
  echo DOCKER=\$(command -v docker >/dev/null && docker --version 2>/dev/null || echo missing)
  echo COMPOSE=\$(docker compose version 2>/dev/null | head -1 || echo missing)
  echo APT=\$(command -v apt-get >/dev/null && echo yes || echo no)
  echo YUM=\$(command -v yum >/dev/null && echo yes || echo no)
  echo CERTBOT=\$(command -v certbot >/dev/null && certbot --version 2>/dev/null || echo missing)
  echo PORT80=\$(ss -tlnp 2>/dev/null | grep -E ':80\s' | head -1 || echo free)
  echo PORT443=\$(ss -tlnp 2>/dev/null | grep -E ':443\s' | head -1 || echo free)
")"

eval_var() { echo "$REMOTE_PROBE" | awk -F= -v key="$1" '$1==key{$1=\"\"; sub(/^=/, \"\"); print; exit}'; }

REMOTE_USER=$(printf '%s\n' "$REMOTE_PROBE" | awk -F= '/^USER=/{sub(/^USER=/,""); print; exit}')
REMOTE_OS=$(printf   '%s\n' "$REMOTE_PROBE" | awk -F= '/^OS=/{sub(/^OS=/,""); print; exit}')
DOCKER_VER=$(printf  '%s\n' "$REMOTE_PROBE" | awk -F= '/^DOCKER=/{sub(/^DOCKER=/,""); print; exit}')
COMPOSE_VER=$(printf '%s\n' "$REMOTE_PROBE" | awk -F= '/^COMPOSE=/{sub(/^COMPOSE=/,""); print; exit}')
APT=$(printf         '%s\n' "$REMOTE_PROBE" | awk -F= '/^APT=/{sub(/^APT=/,""); print; exit}')
YUM=$(printf         '%s\n' "$REMOTE_PROBE" | awk -F= '/^YUM=/{sub(/^YUM=/,""); print; exit}')
CERTBOT_VER=$(printf '%s\n' "$REMOTE_PROBE" | awk -F= '/^CERTBOT=/{sub(/^CERTBOT=/,""); print; exit}')
PORT80=$(printf      '%s\n' "$REMOTE_PROBE" | awk -F= '/^PORT80=/{sub(/^PORT80=/,""); print; exit}')
PORT443=$(printf     '%s\n' "$REMOTE_PROBE" | awk -F= '/^PORT443=/{sub(/^PORT443=/,""); print; exit}')

ok "user=$REMOTE_USER, os=$REMOTE_OS"

if [ "$REMOTE_USER" = "root" ]; then
  ok "user=root, install-relay.sh 不需要 sudo"
else
  warn "user=$REMOTE_USER (非 root), install-relay.sh 需 sudo 权限运行"
fi

if [[ "$DOCKER_VER" == missing* ]]; then
  warn "docker 没装. install-relay.sh 会自动 apt-get/curl get.docker.com 装"
else
  ok "$DOCKER_VER"
fi

if [[ "$COMPOSE_VER" == missing* ]]; then
  fail "docker compose v2 没装. install-relay.sh 要求 v2 (docker compose, 不是 docker-compose v1)"
else
  ok "$COMPOSE_VER"
fi

if [ "$APT" = "yes" ] || [ "$YUM" = "yes" ]; then
  ok "包管理器: apt-get=$APT, yum=$YUM (certbot 安装可用)"
else
  fail "没有 apt-get / yum, install-relay.sh 装 certbot 那步会挂"
fi

if [[ "$CERTBOT_VER" == missing* ]]; then
  warn "certbot 没装, install-relay.sh 会自动安装"
else
  ok "$CERTBOT_VER"
fi

if [[ "$PORT80" == free* ]]; then
  ok "vps 80 端口空闲 (LE HTTP-01 challenge 用)"
else
  warn "80 端口已有进程: $PORT80 (LE 申请期间会冲突)"
fi

if [[ "$PORT443" == free* ]]; then
  ok "vps 443 端口空闲"
else
  warn "443 端口已有进程: $PORT443 (install-relay.sh 启 nginx 时会冲突)"
fi

section "Inbound 80 / 443 (LE challenge + 服务暴露)"
# 不在 vps 上反向连本地 80, 直接在本机用 timeout curl 探.
# 80 上 install-relay 没启进程之前会 connection refused 是预期; LE 之前 timeout 才是问题.
if [ -n "$RESOLVED_IP" ]; then
  for port in 80 443; do
    if timeout 5 bash -c "</dev/tcp/$RESOLVED_IP/$port" 2>/dev/null; then
      ok "外部可达 ${RESOLVED_IP}:${port}"
    else
      # connection refused vs timeout 区分: nc -z 输出含 refused 就是 server 没开 (OK 正常),
      # 否则 (timeout) 是安全组拦了 (FAIL).
      if nc -z -w 3 "$RESOLVED_IP" "$port" 2>&1 | grep -q "refused"; then
        ok "${port} 端口空闲且公网路径通 (服务起来后即可用)"
      else
        fail "${RESOLVED_IP}:${port} 不可达 (连接 timeout). 阿里云安全组**入方向**没放行 ${port}? 在控制台加 TCP ${port} 来源 0.0.0.0/0"
      fi
    fi
  done
fi

section "Summary"
echo "$PASS passed, $WARN warnings, $FAIL failed"
[ "$FAIL" -eq 0 ]
