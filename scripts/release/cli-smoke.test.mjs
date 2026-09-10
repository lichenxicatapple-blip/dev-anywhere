import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedCliEnvironment } from "./cli-smoke.mjs";

test("the CLI child uses an isolated OS home without changing its parent's environment", () => {
  const originalHome = homedir();
  const originalEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const isolatedHome = mkdtempSync(join(tmpdir(), "dev-anywhere-home-test."));
  try {
    const result = spawnSync(process.execPath, ["-p", 'require("node:os").homedir()'], {
      env: isolatedCliEnvironment(isolatedHome),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolve(result.stdout.trim()), resolve(isolatedHome));
    assert.equal(homedir(), originalHome);
    assert.deepEqual(
      { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
      originalEnvironment,
    );
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
