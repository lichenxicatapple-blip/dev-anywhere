import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFontAssetsFromSources } from "../../common/paths.js";

const FAMILY = "sarasa-fixed-sc";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "dev-anywhere-font-assets-"));
}

describe("font asset installation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs bundled font shards into an empty target", () => {
    const source = makeTempDir();
    const target = makeTempDir();
    tempDirs.push(source, target);

    mkdirSync(join(source, FAMILY), { recursive: true });
    writeFileSync(join(source, FAMILY, "result.css"), "/* font css */");
    writeFileSync(join(source, FAMILY, "bullet.woff2"), "font shard");

    const installed = installFontAssetsFromSources(target, [{ dir: source, family: FAMILY }]);

    expect(installed).toBe(true);
    expect(readFileSync(join(target, FAMILY, "result.css"), "utf8")).toBe("/* font css */");
    expect(readFileSync(join(target, FAMILY, "bullet.woff2"), "utf8")).toBe("font shard");
  });

  it("does not overwrite a user-installed font family", () => {
    const source = makeTempDir();
    const target = makeTempDir();
    tempDirs.push(source, target);

    mkdirSync(join(source, FAMILY), { recursive: true });
    mkdirSync(join(target, FAMILY), { recursive: true });
    writeFileSync(join(source, FAMILY, "result.css"), "bundled");
    writeFileSync(join(target, FAMILY, "result.css"), "user");

    const installed = installFontAssetsFromSources(target, [{ dir: source, family: FAMILY }]);

    expect(installed).toBe(false);
    expect(readFileSync(join(target, FAMILY, "result.css"), "utf8")).toBe("user");
  });

  it("uses the first available source so legacy fonts win over bundled defaults", () => {
    const missing = makeTempDir();
    const legacy = makeTempDir();
    const bundled = makeTempDir();
    const target = makeTempDir();
    tempDirs.push(missing, legacy, bundled, target);

    mkdirSync(join(legacy, FAMILY), { recursive: true });
    mkdirSync(join(bundled, FAMILY), { recursive: true });
    writeFileSync(join(legacy, FAMILY, "result.css"), "legacy");
    writeFileSync(join(bundled, FAMILY, "result.css"), "bundled");

    const installed = installFontAssetsFromSources(target, [
      { dir: missing, family: FAMILY },
      { dir: legacy, family: FAMILY },
      { dir: bundled, family: FAMILY },
    ]);

    expect(installed).toBe(true);
    expect(readFileSync(join(target, FAMILY, "result.css"), "utf8")).toBe("legacy");
  });
});
