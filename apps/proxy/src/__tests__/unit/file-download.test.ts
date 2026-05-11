import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileDownload } from "#src/serve/file-download.js";

describe("file download loading", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "file-download-"));
    cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads any text file from session cwd with text/plain when extension unknown", () => {
    const filePath = join(cwd, "notes.txt");
    writeFileSync(filePath, "hello\nworld");

    const result = loadFileDownload({ sessionId: "s1", path: "notes.txt" }, { cwd });

    expect(result.success).toBe(true);
    expect(result.mimeType).toBe("text/plain");
    expect(Buffer.from(result.dataBase64 ?? "", "base64").toString("utf8")).toBe("hello\nworld");
    expect(result.size).toBe(11);
  });

  it("guesses common dev mime types from extension", () => {
    const filePath = join(cwd, "data.json");
    writeFileSync(filePath, "{}");
    expect(loadFileDownload({ sessionId: "s1", path: "data.json" }, { cwd }).mimeType).toBe(
      "application/json",
    );
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    const filePath = join(cwd, "blob.bin");
    writeFileSync(filePath, Buffer.from([1, 2, 3]));
    expect(loadFileDownload({ sessionId: "s1", path: "blob.bin" }, { cwd }).mimeType).toBe(
      "application/octet-stream",
    );
  });

  it("loads absolute paths without a previewRoots whitelist (single-tenant)", () => {
    const outside = join(root, "outside.log");
    writeFileSync(outside, "outside data");

    const result = loadFileDownload({ sessionId: "s1", path: outside }, { cwd });

    expect(result.success).toBe(true);
    expect(result.mimeType).toBe("text/plain");
  });

  it("rejects directories", () => {
    const result = loadFileDownload({ sessionId: "s1", path: cwd }, { cwd });
    expect(result.success).toBe(false);
    expect(result.error).toContain("不是普通文件");
  });

  it("enforces the file size cap", () => {
    const filePath = join(cwd, "huge.bin");
    writeFileSync(filePath, Buffer.alloc(2048));

    const result = loadFileDownload({ sessionId: "s1", path: "huge.bin" }, { cwd, maxBytes: 1024 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("超过");
  });
});
