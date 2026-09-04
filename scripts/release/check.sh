#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "=== Check release scripts ==="
bash -n scripts/release/release.sh
bash -n scripts/release/smoke.sh
bash -n scripts/release/deep.sh
bash -n scripts/lib/stage-timing.sh
bash -n scripts/quality/check.sh
bash -n scripts/deploy/install-relay.sh
bash -n scripts/lib/install-relay-render.sh
bash -n scripts/deploy/check-prerequisite.sh
bash scripts/deploy/install-relay-render.test.sh
bash -n scripts/dev/restart.sh
bash -n scripts/dev/health.sh
bash -n scripts/dev/relay-restart.sh
bash -n scripts/dev/chaos.sh
node --check scripts/tools/emu-debug.mjs
node --check scripts/quality/check-source-comment-refs.mjs
node --check scripts/lib/resolve-dev-profile.mjs
bash scripts/release/options.test.sh
node scripts/release/config.test.mjs
if ! grep -F 'REGISTRY_BASE="${REGISTRY_BASE:-crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip}"' scripts/deploy/install-relay.sh >/dev/null; then
  echo "Release installer must default to the Aliyun ACR deployment registry" >&2
  exit 1
fi
if grep -R "SKIP_PULL" scripts/deploy/install-relay.sh .github/workflows/release.yml >/dev/null; then
  echo "Release installer must always pull published images; SKIP_PULL is not allowed" >&2
  exit 1
fi

echo ""
echo "=== Build release artifacts ==="
pnpm build

echo ""
echo "=== Check @dev-anywhere/proxy package contents ==="
if [ "$(head -n 1 apps/proxy/dist/index.js)" != "#!/usr/bin/env node" ]; then
  echo "Proxy bin dist/index.js must start with a node shebang for npm global execution" >&2
  exit 1
fi
PROXY_PACK_JSON="$(cd apps/proxy && npm pack --dry-run --json --ignore-scripts)"
PACK_JSON="$PROXY_PACK_JSON" node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
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
requireFile("dist/update-runner.js");
requireFile("assets/fonts/sarasa-fixed-sc/result.css");
requireFile("assets/scrcpy/scrcpy-server-v4.1");
requireFile("README.md");
requireFile("LICENSE");
requireFile("THIRD_PARTY_NOTICES.md");
requireFile("licenses/Apache-2.0.txt");
requireFile("licenses/BSD-3-Clause.txt");
requireFile("licenses/Boost-1.0.txt");

const scrcpyServer = readFileSync("apps/proxy/assets/scrcpy/scrcpy-server-v4.1");
const scrcpyServerHash = createHash("sha256").update(scrcpyServer).digest("hex");
const expectedScrcpyServerHash =
  "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
if (scrcpyServer.length !== 733706 || scrcpyServerHash !== expectedScrcpyServerHash) {
  console.error(
    `Invalid bundled scrcpy server: size=${scrcpyServer.length}, sha256=${scrcpyServerHash}`,
  );
  process.exit(1);
}

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
requireFile("assets/web/index.html");
requireFile("assets/web/sw.js");
requireFile("assets/web/manifest.webmanifest");
requireFile("assets/fonts/sarasa-fixed-sc/result.css");
requireFile("README.md");
requireFile("LICENSE");

const webAssetCount = [...files].filter((file) => file.startsWith("assets/web/")).length;
const hashedAssetCount = [...files].filter((file) => file.startsWith("assets/web/assets/")).length;
const fontShardCount = [...files].filter(
  (file) => file.startsWith("assets/fonts/sarasa-fixed-sc/") && file.endsWith(".woff2"),
).length;
if (hashedAssetCount === 0) {
  console.error("Missing bundled Web asset files");
  process.exit(1);
}
if (fontShardCount === 0) {
  console.error("Missing relay package font shards");
  process.exit(1);
}

console.log(
  `relay files=${pack.files.length}, size=${pack.size}, webAssets=${webAssetCount}, fontShards=${fontShardCount}`,
);
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
grep -q '"autoUpdate": true' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"profiles"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"relays"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"relay": "cloud"' "$TMP_HOME/.dev-anywhere/config.json"
grep -q '"url": "ws://localhost:3100"' "$TMP_HOME/.dev-anywhere/config.json"
test -f "$TMP_HOME/.dev-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css"
grep -q "U+2022" "$TMP_HOME/.dev-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css"

echo "release package smoke passed"
