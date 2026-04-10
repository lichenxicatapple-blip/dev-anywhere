#!/usr/bin/env bash
set -euo pipefail

# 在远程服务器上配置本机 SSH 免密登录
# Usage: bash setup-ssh.sh <ssh-host>
# Example: bash setup-ssh.sh root@159.75.2.206
# Note: 首次需要输入密码

SSH_HOST="${1:?Usage: bash setup-ssh.sh <ssh-host>}"
PUB_KEY=$(cat ~/.ssh/id_rsa.pub 2>/dev/null || cat ~/.ssh/id_ed25519.pub 2>/dev/null)

if [ -z "$PUB_KEY" ]; then
  echo "ERROR: No public key found in ~/.ssh/"
  exit 1
fi

echo "Copying public key to $SSH_HOST..."
ssh "$SSH_HOST" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$PUB_KEY' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
echo "Done. Test with: ssh $SSH_HOST"
