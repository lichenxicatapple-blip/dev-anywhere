import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface NpmInstallBackup {
  restore(): Promise<void>;
  dispose(): Promise<void>;
}

/** Keep the complete working package and npm launchers available without a registry connection. */
export async function createNpmInstallBackup(options: {
  packageRoot: string;
  packageName: string;
  binPaths: string[];
}): Promise<NpmInstallBackup> {
  const { packageRoot, packageName, binPaths } = options;
  const directory = await mkdtemp(join(dirname(packageRoot), ".dev-anywhere-update-"));
  const savedPackage = join(directory, "package");
  const savedBins: { path: string; backup: string }[] = [];
  let restored = false;
  let preserve = false;
  try {
    await cp(packageRoot, savedPackage, { recursive: true, verbatimSymlinks: true });
    for (const [index, path] of binPaths.entries()) {
      let entry;
      try {
        entry = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!entry.isFile() && !entry.isSymbolicLink())
        throw new Error(`Cannot back up npm launcher: ${path}`);
      const backup = join(directory, `bin-${index}`);
      await cp(path, backup, { verbatimSymlinks: true });
      savedBins.push({ path, backup });
    }

    // npm reuses a hashed sibling path when retiring this package. On Windows cleanup can
    // delete package.json but leave mapped DLLs behind. A second install then tries to copy
    // over those DLLs and fails with EBUSY. Quarantine the retired directory before npm runs,
    // including that partially cleaned state; loaded modules continue using their open files.
    const prefix = `.${basename(packageRoot)}-`;
    for (const entry of await readdir(dirname(packageRoot), { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(prefix) ||
        !/^[a-zA-Z0-9]{8}$/.test(entry.name.slice(prefix.length))
      )
        continue;
      const retired = join(dirname(packageRoot), entry.name);
      try {
        const manifest = JSON.parse(await readFile(join(retired, "package.json"), "utf8")) as {
          name?: unknown;
        } | null;
        if (manifest?.name !== packageName) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      await rename(retired, join(directory, entry.name));
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    async restore() {
      if (restored) return;
      // Preserve recovery files if any step fails, including restoring the executable launchers.
      preserve = true;
      const failedPackage = join(directory, "failed-package");
      let moved = false;
      try {
        await rename(packageRoot, failedPackage);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(savedPackage, packageRoot);
      } catch (error) {
        if (moved) await rename(failedPackage, packageRoot);
        throw error;
      }
      for (const { path, backup } of savedBins) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await cp(backup, path, { verbatimSymlinks: true });
      }
      restored = true;
      preserve = false;
    },
    async dispose() {
      if (!preserve) await rm(directory, { recursive: true, force: true });
    },
  };
}
