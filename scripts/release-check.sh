#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Check release scripts ==="
bash -n scripts/install-relay.sh
bash -n scripts/dev-restart.sh
bash -n scripts/dev-health.sh
bash -n scripts/dev-relay-restart.sh
if ! grep -F 'REGISTRY_BASE="${REGISTRY_BASE:-crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip}"' scripts/install-relay.sh >/dev/null; then
  echo "Release installer must default to the Aliyun ACR deployment registry" >&2
  exit 1
fi
if grep -R "SKIP_PULL" scripts/install-relay.sh .github/workflows/release.yml >/dev/null; then
  echo "Release installer must always pull published images; SKIP_PULL is not allowed" >&2
  exit 1
fi

echo ""
echo "=== Build release artifacts ==="
pnpm build

echo ""
echo "=== Check @dev-anywhere/proxy package contents ==="
PROXY_PACK_JSON="$(cd apps/proxy && npm pack --dry-run --json --ignore-scripts)"
PACK_JSON="$PROXY_PACK_JSON" node <<'NODE'
const pack = JSON.parse(process.env.PACK_JSON)[0];
const files = new Set(pack.files.map((file) => file.path));

function requireFile(path) {
  if (!files.has(path)) {
    console.error(`Missing proxy package file: ${path}`);
    process.exit(1);
  }
}

requireFile("dist/index.js");
requireFile("dist/serve.js");
requireFile("dist/session-worker.js");
requireFile("assets/fonts/sarasa-fixed-sc/result.css");
requireFile("README.md");
requireFile("LICENSE");

const fontShardCount = [...files].filter((file) =>
  file.startsWith("assets/fonts/sarasa-fixed-sc/") && file.endsWith(".woff2"),
).length;
if (fontShardCount === 0) {
  console.error("Missing proxy package font shards");
  process.exit(1);
}

console.log(`proxy files=${pack.files.length}, size=${pack.size}, fontShards=${fontShardCount}`);
NODE

echo ""
echo "=== Check @dev-anywhere/relay package contents ==="
RELAY_PACK_JSON="$(cd apps/relay && npm pack --dry-run --json --ignore-scripts)"
PACK_JSON="$RELAY_PACK_JSON" node <<'NODE'
const pack = JSON.parse(process.env.PACK_JSON)[0];
const files = new Set(pack.files.map((file) => file.path));

function requireFile(path) {
  if (!files.has(path)) {
    console.error(`Missing relay package file: ${path}`);
    process.exit(1);
  }
}

requireFile("dist/index.js");
requireFile("dist/server.js");
requireFile("README.md");
requireFile("LICENSE");

console.log(`relay files=${pack.files.length}, size=${pack.size}`);
NODE

echo ""
echo "=== Check installed command behavior with isolated HOME ==="
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-release-check.XXXXXX")"
cleanup() {
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

HOME="$TMP_HOME" node apps/proxy/dist/index.js --version >/dev/null
HOME="$TMP_HOME" node apps/proxy/dist/index.js init
HOME="$TMP_HOME" node apps/proxy/dist/index.js serve status >/dev/null

test -f "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"defaultProfile": "default"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"profiles"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"relays"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"relay": "cloud"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"url": "ws://localhost:3100"' "$TMP_HOME/.dev-anywhere/config.json"
test -f "$TMP_HOME/.dev-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css"
grep -q "U+2022" "$TMP_HOME/.dev-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css"

echo "release package smoke passed"
