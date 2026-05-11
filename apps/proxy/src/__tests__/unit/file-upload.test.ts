import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFileUpload } from "#src/serve/file-upload.js";

describe("file upload saving", () => {
  let root: string;
  let cwd: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "file-upload-"));
    cwd = join(root, "project");
    dataDir = join(root, "data");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("decodes base64 into the project's .dev-anywhere/uploads/<session> directory when cwd exists", async () => {
    const data = Buffer.from("hello upload");
    const result = await saveFileUpload(
      {
        sessionId: "s1",
        mimeType: "text/plain",
        dataBase64: data.toString("base64"),
        fileName: "notes.txt",
      },
      { cwd, dataDir, randomSuffix: () => "abc123", now: () => 0 },
    );

    expect(result.success).toBe(true);
    const writtenAbs = join(cwd, result.path);
    expect(readFileSync(writtenAbs)).toEqual(data);
  });

  it("falls back to dataDir when cwd write fails", async () => {
    // 让 cwd 不可写: 把它替换成一个已存在的文件
    const file = join(root, "blocked");
    writeFileSync(file, "");
    const result = await saveFileUpload(
      {
        sessionId: "s2",
        mimeType: "application/octet-stream",
        dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
        fileName: "blob.bin",
      },
      { cwd: file, dataDir, randomSuffix: () => "xyz", now: () => 0 },
    );

    expect(result.success).toBe(true);
    expect(result.path.startsWith(dataDir)).toBe(true);
  });

  it("rejects payloads that exceed the 100MB cap", async () => {
    // 构造一个声称超过上限的 base64 (实际 buffer 不需要那么大, 通过 length 检查先短路)
    const oversize = "A".repeat(Math.ceil((100 * 1024 * 1024) / 3) * 4 + 8);
    const result = await saveFileUpload(
      {
        sessionId: "s3",
        mimeType: "application/octet-stream",
        dataBase64: oversize,
        fileName: "huge.bin",
      },
      { cwd, dataDir },
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
      { cwd, dataDir },
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
      { cwd, dataDir, randomSuffix: () => "rand9", now: () => 1000 },
    );

    expect(result.success).toBe(true);
    expect(result.path).not.toContain("..");
    expect(result.path).toMatch(/passwd\.txt$/);
  });

  it("falls back to upload-<stamp>-<suffix><ext> when filename has unsafe characters", async () => {
    const result = await saveFileUpload(
      {
        sessionId: "s5b",
        mimeType: "text/plain",
        dataBase64: Buffer.from("x").toString("base64"),
        fileName: "笔记 v2.md",
      },
      { cwd, dataDir, randomSuffix: () => "rand9", now: () => 1000 },
    );
    expect(result.success).toBe(true);
    expect(result.path).toMatch(/upload-\d{14}-rand9\.md$/);
  });

  it("appends .dev-anywhere/ to .gitignore when the project has one", async () => {
    const gitignorePath = join(cwd, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    await saveFileUpload(
      {
        sessionId: "s6",
        mimeType: "text/plain",
        dataBase64: Buffer.from("x").toString("base64"),
        fileName: "ok.txt",
      },
      { cwd, dataDir, randomSuffix: () => "r" },
    );
    const updated = readFileSync(gitignorePath, "utf-8");
    expect(updated).toMatch(/\.dev-anywhere\//);
  });
});
