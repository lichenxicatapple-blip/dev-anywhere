import assert from "node:assert/strict";
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

const rootPackage = readJson("package.json");
const manifest = readJson(".release-please-manifest.json");
const config = readJson("release-please-config.json");
const versionFiles = [
  "apps/proxy/package.json",
  "apps/relay/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
];

assert.match(rootPackage.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest["."], rootPackage.version);
assert.equal(config["release-type"], "node");
assert.equal(config["include-v-in-tag"], true);
assert.equal(config["include-component-in-tag"], false);
assert.equal(config.packages["."] !== undefined, true);

const configuredFiles = config.packages["."]["extra-files"];
assert.deepEqual(configuredFiles.map(({ path }) => path).sort(), versionFiles.toSorted());

for (const entry of configuredFiles) {
  assert.equal(entry.type, "json");
  assert.equal(entry.jsonpath, "$.version");
}

for (const path of versionFiles) {
  assert.equal(readJson(path).version, rootPackage.version, `${path} version drifted`);
}

const releasePleaseWorkflow = fs.readFileSync(".github/workflows/release-please.yml", "utf8");
const expectedCiNodeVersion = "22.22.0";
const assertPinnedCiNode = (workflow, path) => {
  const versions = [...workflow.matchAll(/node-version:\s*["']?([^\s"']+)/g)].map(
    ([, version]) => version,
  );
  assert.ok(versions.length > 0, `${path} must configure a Node runtime`);
  assert.deepEqual(
    [...new Set(versions)],
    [expectedCiNodeVersion],
    `${path} must not float across unverified Node patch releases`,
  );
};

assert.match(releasePleaseWorkflow, /googleapis\/release-please-action@v4/);
assert.match(releasePleaseWorkflow, /group: release-please-\$\{\{ github\.ref \}\}/);
assert.match(releasePleaseWorkflow, /cancel-in-progress: true/);
assert.match(releasePleaseWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
assert.match(
  releasePleaseWorkflow,
  /needs:\s*\n\s*- verify\s*\n\s*- verify-chaos\s*\n\s*- verify-android/,
);
assert.match(releasePleaseWorkflow, /RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1/);
assert.match(releasePleaseWorkflow, /Configure isolated local runtime/);
assert.match(releasePleaseWorkflow, /ws:\/\/localhost:3100/);
assert.match(releasePleaseWorkflow, /path: ~\/\.dev-anywhere/);
assert.match(releasePleaseWorkflow, /include-hidden-files: true/);
assert.match(releasePleaseWorkflow, /reactivecircus\/android-emulator-runner@v2/);
assert.match(releasePleaseWorkflow, /TEST_MOBILE_REQUIRE_EMULATOR=1/);
assert.match(releasePleaseWorkflow, /release_created == 'true'/);
assert.match(
  releasePleaseWorkflow,
  /release-please:\s*\n\s*name: Prepare or create release\s*\n\s*runs-on:/,
);
assert.match(
  releasePleaseWorkflow,
  /publish:\s*\n(?:.|\n)*?needs:\s*\n\s*- verify\s*\n\s*- verify-chaos\s*\n\s*- verify-android\s*\n\s*- release-please/,
);
assert.match(releasePleaseWorkflow, /uses: \.\/\.github\/workflows\/release\.yml/);
assert.match(releasePleaseWorkflow, /secrets: inherit/);

const ciWorkflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
assertPinnedCiNode(ciWorkflow, ".github/workflows/ci.yml");
assertPinnedCiNode(releasePleaseWorkflow, ".github/workflows/release-please.yml");
assert.match(ciWorkflow, /pull_request:/);
assert.match(ciWorkflow, /workflow_call:/);
assert.match(ciWorkflow, /pnpm test/);
assert.match(ciWorkflow, /pnpm release:check/);
assert.match(ciWorkflow, /pnpm test:layout -- --workers=1 --reporter=line/);
assert.match(ciWorkflow, /pnpm test:pc -- --workers=1 --reporter=line/);
assert.match(ciWorkflow, /mcr\.microsoft\.com\/playwright:v1\.52\.0-noble/);
assert.match(ciWorkflow, /apt-get install -y --no-install-recommends build-essential/);
assert.doesNotMatch(ciWorkflow, /playwright install --with-deps chromium/);

const publishWorkflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
assertPinnedCiNode(publishWorkflow, ".github/workflows/release.yml");
assert.match(publishWorkflow, /workflow_call:/);
assert.match(publishWorkflow, /workflow_dispatch:/);
assert.match(publishWorkflow, /provenance: false/);
assert.match(publishWorkflow, /sbom: false/);
assert.match(publishWorkflow, /type=raw,value=\$\{\{ needs\.resolve-release\.outputs\.tag \}\}/);
assert.match(publishWorkflow, /Ensure GitHub Release/);

console.log(`release config test passed (${rootPackage.version})`);
