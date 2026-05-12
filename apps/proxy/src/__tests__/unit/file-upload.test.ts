import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFileUpload } from "#src/serve/file-upload.js";

describe("file upload saving", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "file-upload-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes up-<suffix>.<ext> directly under the data dir as an absolute path", async () => {
    const data = Buffer.from("hello upload");
    const result = await saveFileUpload(
      {
        sessionId: "s1",
        mimeType: "text/plain",
        dataBase64: data.toString("base64"),
        fileName: "notes.txt",
      },
      { dataDir, randomSuffix: () => "abc123" },
    );

    expect(result).toEqual({
      success: true,
      path: join(dataDir, "up-abc123.txt"),
    });
    expect(readFileSync(result.path!)).toEqual(data);
  });

  it("drops unsafe extensions but keeps known short ones", async () => {
    const data = Buffer.from("x");
    const safe = await saveFileUpload(
      {
        sessionId: "s1",
        mimeType: "text/plain",
        dataBase64: data.toString("base64"),
        fileName: "笔记 v2.md",
      },
      { dataDir, randomSuffix: () => "abc" },
    );
    expect(safe.path).toBe(join(dataDir, "up-abc.md"));

    const noExt = await saveFileUpload(
      {
        sessionId: "s2",
        mimeType: "application/octet-stream",
        dataBase64: data.toString("base64"),
        fileName: "binary-blob",
      },
      { dataDir, randomSuffix: () => "def" },
    );
    expect(noExt.path).toBe(join(dataDir, "up-def"));

    const longExt = await saveFileUpload(
      {
        sessionId: "s3",
        mimeType: "application/octet-stream",
        dataBase64: data.toString("base64"),
        fileName: "archive.verylongext",
      },
      { dataDir, randomSuffix: () => "ghi" },
    );
    expect(longExt.path).toBe(join(dataDir, "up-ghi"));
  });

  it("rejects payloads that exceed the 100MB cap", async () => {
    const oversize = "A".repeat(Math.ceil((100 * 1024 * 1024) / 3) * 4 + 8);
    const result = await saveFileUpload(
      {
        sessionId: "s3",
        mimeType: "application/octet-stream",
        dataBase64: oversize,
        fileName: "huge.bin",
      },
      { dataDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("100MB");
  });

  it("rejects malformed base64", async () => {
    const result = await saveFileUpload(
      {
        sessionId: "s4",
        mimeType: "text/plain",
        dataBase64: "$$not-base64$$",
        fileName: "bad.txt",
      },
      { dataDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("base64");
  });

  it("strips path components from filenames so traversal segments never reach disk", async () => {
    const result = await saveFileUpload(
      {
        sessionId: "s5",
        mimeType: "text/plain",
        dataBase64: Buffer.from("x").toString("base64"),
        fileName: "../../etc/passwd.txt",
      },
      { dataDir, randomSuffix: () => "rand9" },
    );

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(dataDir, "up-rand9.txt"));
    expect(existsSync(result.path!)).toBe(true);
    expect(existsSync(join(dataDir, "..", "..", "etc", "passwd.txt"))).toBe(false);
  });
});
