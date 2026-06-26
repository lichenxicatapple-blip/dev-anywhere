import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guessMimeType, resolveRemoteFilePath } from "#src/serve/remote-file-path.js";

describe("remote-file-path", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-anywhere-remote-file-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves relative paths from session cwd", () => {
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello");

    expect(resolveRemoteFilePath("notes.txt", dir)).toBe(realpathSync(file));
  });

  it("resolves absolute paths without a preview whitelist", () => {
    const file = join(dir, "outside.log");
    writeFileSync(file, "hello");

    expect(resolveRemoteFilePath(file, "/tmp/other-cwd")).toBe(realpathSync(file));
  });

  it("expands shell-style home paths before resolving remote files", () => {
    const homeRelativeDir = join(".dev-anywhere-test", `remote-file-${Date.now()}`);
    const homeDir = join(homedir(), homeRelativeDir);
    mkdirSync(homeDir, { recursive: true });
    const file = join(homeDir, "preview.jpg");
    writeFileSync(file, "jpeg");

    try {
      expect(resolveRemoteFilePath(`~/${relative(homedir(), file)}`, dir)).toBe(realpathSync(file));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("guesses common mime types and falls back to octet-stream", () => {
    expect(guessMimeType("/tmp/data.json")).toBe("application/json");
    expect(guessMimeType("/tmp/shot.png")).toBe("image/png");
    expect(guessMimeType("/tmp/archive.unknown")).toBe("application/octet-stream");
  });
});
