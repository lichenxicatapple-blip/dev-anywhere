import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImagePreview } from "#src/serve/image-preview.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const WEBP_BYTES = Buffer.from("RIFFxxxxWEBPVP8 ", "ascii");

describe("image preview loading", () => {
  let root: string;
  let cwd: string;
  let tempRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "image-preview-"));
    cwd = join(root, "project");
    tempRoot = join(root, "tmp");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads project-relative images from the session cwd", () => {
    writeFileSync(join(cwd, ".dev-anywhere-shot.png"), PNG_BYTES);

    const result = loadImagePreview(
      { sessionId: "s1", path: ".dev-anywhere-shot.png" },
      { cwd, tmpDir: tempRoot },
    );

    expect(result).toEqual({
      success: true,
      sessionId: "s1",
      path: ".dev-anywhere-shot.png",
      mimeType: "image/png",
      dataBase64: PNG_BYTES.toString("base64"),
      size: PNG_BYTES.length,
    });
  });

  it("loads absolute images from the configured system temp directory", () => {
    const imagePath = join(tempRoot, "playwright", "shot.jpg");
    mkdirSync(join(tempRoot, "playwright"));
    writeFileSync(imagePath, JPEG_BYTES);

    const result = loadImagePreview(
      { sessionId: "s1", path: imagePath },
      { cwd, tmpDir: tempRoot },
    );

    expect(result.success).toBe(true);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.dataBase64).toBe(JPEG_BYTES.toString("base64"));
  });

  it("loads absolute images from explicit preview roots", () => {
    const previewRoot = join(root, "screenshots");
    const imagePath = join(previewRoot, "shot.webp");
    mkdirSync(previewRoot);
    writeFileSync(imagePath, WEBP_BYTES);

    const result = loadImagePreview(
      { sessionId: "s1", path: imagePath },
      { cwd, tmpDir: tempRoot, previewRoots: [previewRoot] },
    );

    expect(result.success).toBe(true);
    expect(result.mimeType).toBe("image/webp");
  });

  it("rejects relative paths that escape the session cwd", () => {
    writeFileSync(join(root, "secret.png"), PNG_BYTES);

    const result = loadImagePreview(
      { sessionId: "s1", path: "../secret.png" },
      { cwd, tmpDir: tempRoot },
    );

    expect(result).toMatchObject({
      success: false,
      sessionId: "s1",
      path: "../secret.png",
      errorCode: "INVALID_PATH",
    });
  });

  it("rejects absolute images outside allowed roots", () => {
    const imagePath = join(root, "outside", "secret.png");
    mkdirSync(join(root, "outside"));
    writeFileSync(imagePath, PNG_BYTES);

    const result = loadImagePreview(
      { sessionId: "s1", path: imagePath },
      { cwd, tmpDir: tempRoot },
    );

    expect(result).toMatchObject({
      success: false,
      sessionId: "s1",
      path: imagePath,
      errorCode: "INVALID_PATH",
    });
  });

  it("rejects symlinks inside the cwd that resolve outside allowed roots", () => {
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.png"), PNG_BYTES);
    symlinkSync(outsideDir, join(cwd, "linked-outside"));

    const result = loadImagePreview(
      { sessionId: "s1", path: "linked-outside/secret.png" },
      { cwd, tmpDir: tempRoot },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "INVALID_PATH",
    });
  });

  it("rejects files that are not supported images", () => {
    writeFileSync(join(cwd, "notes.txt"), "not an image");

    const result = loadImagePreview(
      { sessionId: "s1", path: "notes.txt" },
      { cwd, tmpDir: tempRoot },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "UNKNOWN",
      error: "不支持这种图片格式",
    });
  });
});
