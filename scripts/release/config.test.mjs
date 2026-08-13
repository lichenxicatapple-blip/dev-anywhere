import assert from "node:assert/strict";
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

const rootPackage = readJson("package.json");
const versionFiles = [
  "apps/proxy/package.json",
  "apps/relay/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
];

assert.match(rootPackage.version, /^\d+\.\d+\.\d+$/);
for (const path of versionFiles) {
  assert.equal(readJson(path).version, rootPackage.version, `${path} version drifted`);
}

const mainWorkflow = fs.readFileSync(".github/workflows/main.yml", "utf8");
const expectedCiNodeVersion = "22.22.2";
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

assert.match(mainWorkflow, /name: Main Verification/);
assert.match(mainWorkflow, /group: main-verification-\$\{\{ github\.ref \}\}/);
assert.match(mainWorkflow, /cancel-in-progress: true/);
assert.match(mainWorkflow, /permissions:\s*\n\s*contents: read/);
assert.match(mainWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
assert.match(mainWorkflow, /RELEASE_DEEP_SCOPE=chaos RELEASE_DEEP_SKIP_FAST=1/);
assert.match(mainWorkflow, /Configure isolated local runtime/);
assert.match(mainWorkflow, /ws:\/\/localhost:3100/);
assert.match(mainWorkflow, /path: ~\/\.dev-anywhere/);
assert.match(mainWorkflow, /include-hidden-files: true/);
assert.doesNotMatch(mainWorkflow, /verify-android|android-emulator-runner|pnpm test:mobile/);
assert.doesNotMatch(mainWorkflow, /release-please|release_created|Publish release artifacts/);
assert.doesNotMatch(mainWorkflow, /uses: \.\/\.github\/workflows\/release\.yml/);

const ciWorkflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
assertPinnedCiNode(ciWorkflow, ".github/workflows/ci.yml");
assertPinnedCiNode(mainWorkflow, ".github/workflows/main.yml");
assert.match(ciWorkflow, /pull_request:/);
assert.match(ciWorkflow, /workflow_call:/);
assert.match(ciWorkflow, /pnpm test/);
assert.match(ciWorkflow, /pnpm release:check/);
assert.match(ciWorkflow, /pnpm test:layout -- --workers=1 --max-failures=1 --reporter=line/);
assert.match(ciWorkflow, /pnpm test:pc -- --workers=1 --max-failures=1 --reporter=line/);
assert.match(ciWorkflow, /playwright install --with-deps chromium/);
assert.match(ciWorkflow, /browser-smoke:(?:.|\n)*?runs-on: ubuntu-22\.04/);
assert.match(ciWorkflow, /name: Upload browser diagnostics/);
assert.match(ciWorkflow, /uses: actions\/upload-artifact@v4/);
assert.match(ciWorkflow, /apps\/web\/test-results/);

const smokeCommon = fs.readFileSync("scripts/lib/smoke-common.sh", "utf8");
assert.match(smokeCommon, /pnpm --dir "\$root\/packages\/shared" run build/);
assert.match(smokeCommon, /shared-build\.log/);

const publishWorkflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
assertPinnedCiNode(publishWorkflow, ".github/workflows/release.yml");
assert.match(publishWorkflow, /workflow_dispatch:/);
assert.match(publishWorkflow, /push:\s*\n\s*tags:\s*\n\s*- "v\*\.\*\.\*"/);
assert.doesNotMatch(publishWorkflow, /workflow_call:/);
assert.match(publishWorkflow, /provenance: false/);
assert.match(publishWorkflow, /sbom: false/);
assert.match(publishWorkflow, /type=raw,value=\$\{\{ needs\.resolve-release\.outputs\.tag \}\}/);
assert.match(publishWorkflow, /Ensure GitHub Release/);

console.log(`release config test passed (${rootPackage.version})`);
