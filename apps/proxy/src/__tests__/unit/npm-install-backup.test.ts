import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNpmInstallBackup } from "#src/common/npm-install-backup.js";
import { runRelayDirectedUpdate, type RelayDirectedUpdateDeps } from "#src/update-runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "da-update-backup-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules", "@dev-anywhere", "proxy");
  const binPaths = ["dev-anywhere", "dev-anywhere.cmd", "dev-anywhere.ps1"].map((name) =>
    join(root, name),
  );
  const packageName = "@dev-anywhere/proxy";
  const writePackage = async (version: string, complete = true) => {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
    if (complete) {
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await mkdir(join(packageRoot, "node_modules", "fixture-dep"), { recursive: true });
      await writeFile(
        join(packageRoot, "node_modules", "fixture-dep", "index.js"),
        `module.exports = ${JSON.stringify(version)};`,
      );
      await writeFile(
        join(packageRoot, "dist", "index.js"),
        "console.log(require('fixture-dep'));",
        { mode: 0o755 },
      );
    }
  };
  await writePackage("0.9.8");
  if (process.platform === "win32") await writeFile(binPaths[0]!, "original launcher");
  else await symlink(relative(root, join(packageRoot, "dist", "index.js")), binPaths[0]!);
  await writeFile(binPaths[1]!, "original cmd launcher");
  await writeFile(binPaths[2]!, "original PowerShell launcher");
  const validate = async (version: string) => {
    expect(
      execFileSync(process.execPath, [join(packageRoot, "dist", "index.js")], {
        encoding: "utf8",
      }).trim(),
    ).toBe(version);
  };
  return { root, packageRoot, packageName, binPaths, writePackage, validate };
}

describe("npm installation recovery", () => {
  it("restores a timed-out install and missing launchers offline, then retries past npm's retired directory", async () => {
    const f = await fixture();
    const originalBins = await Promise.all(f.binPaths.map((path) => readFile(path, "utf8")));
    const retired = join(dirname(f.packageRoot), ".proxy-6BH2bq16");
    let attempt = 0;
    const deps: RelayDirectedUpdateDeps = {
      acquireLock: () => ({ release() {} }),
      resolveNpm: () => "npm",
      verifyNpm: async () => undefined,
      readInstalledVersion: () => "0.9.8",
      backupInstallation: () => createNpmInstallBackup(f),
      validateInstalledCli: f.validate,
      installVersion: vi.fn(async (_npm, version) => {
        // npm retires the old directory before it downloads and extracts the replacement.
        await rename(f.packageRoot, retired);
        await Promise.all(f.binPaths.map((path) => unlink(path)));
        await f.writePackage(version, ++attempt !== 1);
        if (attempt === 1) throw new Error("npm install timed out");
      }),
      restartWithRecovery: vi.fn(async () => undefined),
    };
    const options = { runningVersion: "0.9.8", targetVersion: "0.9.9", relayName: "cloud" };
    await expect(runRelayDirectedUpdate(options, deps)).rejects.toThrow("restored 0.9.8");
    await f.validate("0.9.8");
    expect(await Promise.all(f.binPaths.map((path) => readFile(path, "utf8")))).toEqual(
      originalBins,
    );
    expect(deps.installVersion).toHaveBeenCalledOnce();
    expect(deps.restartWithRecovery).not.toHaveBeenCalled();
    expect((await stat(retired)).isDirectory()).toBe(true);

    await expect(runRelayDirectedUpdate(options, deps)).resolves.toBe(0);
    await f.validate("0.9.9");
    expect(deps.installVersion).toHaveBeenCalledTimes(2);
    expect(deps.restartWithRecovery).toHaveBeenCalledOnce();
  });

  it("leaves unrelated sibling directories untouched", async () => {
    const f = await fixture();
    const other = join(dirname(f.packageRoot), ".proxy-something-else");
    await mkdir(other);
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "other-package" }));
    const backup = await createNpmInstallBackup(f);
    await backup.dispose();
    expect(JSON.parse(await readFile(join(other, "package.json"), "utf8"))).toEqual({
      name: "other-package",
    });
  });

  it("keeps recovery files if restoring an npm launcher fails", async () => {
    const f = await fixture();
    const backup = await createNpmInstallBackup(f);
    await unlink(f.binPaths[0]!);
    await mkdir(f.binPaths[0]!);
    await expect(backup.restore()).rejects.toThrow();
    await backup.dispose();
    const retained = (await readdir(dirname(f.packageRoot))).filter((name) =>
      name.startsWith(".dev-anywhere-update-"),
    );
    expect(retained).toHaveLength(1);
    expect(await readFile(join(dirname(f.packageRoot), retained[0]!, "bin-1"), "utf8")).toBe(
      "original cmd launcher",
    );
    await f.validate("0.9.8");
  });
});
