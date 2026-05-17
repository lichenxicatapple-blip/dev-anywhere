import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlinkIfPresent } from "#src/common/safe-unlink.js";

describe("unlinkIfPresent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "safe-unlink-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes an existing file", () => {
    const path = join(tmpDir, "service.pid");
    writeFileSync(path, "123");

    unlinkIfPresent(path);

    expect(existsSync(path)).toBe(false);
  });

  it("does not throw when the file is already gone", () => {
    const path = join(tmpDir, "missing.pid");

    expect(() => unlinkIfPresent(path)).not.toThrow();
  });

  it("does not throw when another cleanup wins the unlink race", () => {
    const path = join(tmpDir, "raced.pid");
    const unlink = vi.fn(() => {
      const err = new Error("already removed") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(() => unlinkIfPresent(path, unlink)).not.toThrow();
    expect(unlink).toHaveBeenCalledWith(path);
  });

  it("rethrows non-ENOENT failures", () => {
    const path = join(tmpDir, "blocked.pid");
    const unlink = vi.fn(() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    expect(() => unlinkIfPresent(path, unlink)).toThrow("permission denied");
  });
});
