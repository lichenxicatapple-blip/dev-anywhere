#!/usr/bin/env bash
# 本地开发环境一键重启：build all → restart relay → restart proxy → rebuild H5
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Building all packages ==="
pnpm -r run build

echo ""
echo "=== Restarting relay ==="
# 杀掉旧 relay 进程
RELAY_PID=$(lsof -ti :3100 2>/dev/null || true)
if [ -n "$RELAY_PID" ]; then
  kill $RELAY_PID 2>/dev/null || true
  sleep 1
fi
nohup pnpm --filter relay run dev &>/dev/null &
sleep 2
if lsof -i :3100 -sTCP:LISTEN &>/dev/null; then
  echo "Relay started on :3100 (log: ~/.dev-anywhere/logs/relay.log)"
else
  echo "ERROR: Relay failed to start, check ~/.dev-anywhere/logs/relay.log"
  exit 1
fi

echo ""
echo "=== Restarting proxy ==="
pnpm --filter proxy run dev -- serve restart

echo ""
echo "=== Building H5 ==="
pnpm --filter feishu run build:h5

echo ""
echo "=== All services restarted ==="
echo "  Relay:  http://localhost:3100"
echo "  H5:    http://localhost:5175"
