#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

STATIC_ONLY=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --static-only)
      STATIC_ONLY=1
      shift
      ;;
    *)
      echo "usage: bash scripts/release/check.sh [--static-only]" >&2
      echo "ERROR: unexpected argument: $1" >&2
      exit 2
      ;;
  esac
done

echo "=== Check release scripts ==="
bash -n scripts/release/check.sh
bash -n scripts/release/release.sh
bash -n scripts/release/smoke.sh
bash -n scripts/release/deep.sh
bash -n scripts/lib/stage-timing.sh
bash -n scripts/quality/check.sh
bash -n scripts/deploy/install-relay.sh
bash -n scripts/lib/install-relay-render.sh
bash -n scripts/deploy/check-prerequisite.sh
bash -n scripts/dev/restart.sh
bash -n scripts/dev/health.sh
bash -n scripts/dev/relay-restart.sh
bash -n scripts/dev/chaos.sh
node --check scripts/tools/emu-debug.mjs
node --check scripts/quality/check-source-comment-refs.mjs
node --check scripts/lib/resolve-dev-profile.mjs
if [[ "$STATIC_ONLY" != "1" ]]; then
  bash scripts/deploy/install-relay-render.test.sh
  bash scripts/release/options.test.sh
  node scripts/release/config.test.mjs
else
  echo "=== Static-only release check: skipping test scripts and runtime smoke ==="
fi
if ! grep -F 'REGISTRY_BASE="${REGISTRY_BASE:-crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip}"' scripts/deploy/install-relay.sh >/dev/null; then
  echo "Release installer must default to the Aliyun ACR deployment registry" >&2
  exit 1
fi
if grep -R "SKIP_PULL" scripts/deploy/install-relay.sh .github/workflows/release.yml >/dev/null; then
  echo "Release installer must always pull published images; SKIP_PULL is not allowed" >&2
  exit 1
fi

echo "=== Check package version consistency ==="
node <<'NODE'
const files = [
  "package.json",
  "apps/proxy/package.json",
  "apps/relay/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
];
const expected = require("./package.json").version;
if (!/^\d+\.\d+\.\d+$/.test(expected)) throw new Error(`Invalid package version: ${expected}`);
for (const file of files) {
  const actual = require(`./${file}`).version;
  if (actual !== expected) throw new Error(`${file}: expected ${expected}, got ${actual}`);
}
NODE

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
requireFile("dist/terminal-worker.js");
requireFile("dist/update-runner.js");
requireFile("scripts/postinstall.cjs");
requireFile("assets/fonts/sarasa-fixed-sc/result.css");
requireFile("assets/scrcpy/scrcpy-server-v4.1");
requireFile("README.md");
requireFile("LICENSE");
requireFile("THIRD_PARTY_NOTICES.md");
requireFile("licenses/Apache-2.0.txt");
requireFile("licenses/BSD-3-Clause.txt");
requireFile("licenses/Boost-1.0.txt");

const testFiles = [...files].filter((path) =>
  /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/.test(path),
);
if (testFiles.length) {
  console.error(`Proxy package contains test artifacts: ${testFiles.join(", ")}`);
  process.exit(1);
}

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

if [[ "$STATIC_ONLY" == "1" ]]; then
  echo "release static package checks passed (tests and runtime smoke skipped)"
  exit 0
fi

echo ""
echo "=== Check installed command behavior with isolated HOME ==="
# macOS TMPDIR can make the derived Unix socket path exceed the platform limit.
TMP_HOME="$(mktemp -d /tmp/dev-anywhere-release-check.XXXXXX)"
cleanup() {
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT

HOME="$TMP_HOME" node apps/proxy/dist/index.js --version >/dev/null
HOME="$TMP_HOME" node apps/proxy/dist/index.js init
STATUS_EXIT=0
STATUS_OUTPUT="$(HOME="$TMP_HOME" node apps/proxy/dist/index.js serve status)" || STATUS_EXIT=$?
if [ "$STATUS_EXIT" -ne 0 ] || ! grep -Fxq "Service: not running" <<< "$STATUS_OUTPUT"; then
  echo "Expected an unstarted service with exit 0; got exit $STATUS_EXIT: $STATUS_OUTPUT" >&2
  exit 1
fi

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
