import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveClipboardImageUpload,
  type ClipboardImageUploadRequest,
} from "#src/serve/clipboard-image-upload.js";

describe("clipboard image upload storage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clipboard-image-upload-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stores base64 image payloads under the session clipboard directory", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "s1",
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      },
      { dataDir: root, now: () => 1_700_000_000_000, randomSuffix: () => "abc123" },
    );

    expect(result).toEqual({
      success: true,
      path: join(root, "s1", "clipboard", "pasted-20231114-221320-abc123.png"),
    });
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects unsupported clipboard image MIME types", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "s1",
        mimeType: "image/svg+xml",
        dataBase64: "PHN2Zy8+",
      } as ClipboardImageUploadRequest,
      { dataDir: root, now: () => 1_700_000_000_000, randomSuffix: () => "abc123" },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "UNKNOWN",
    });
  });

  it("rejects oversized base64 payloads before accepting invalid image text", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "s1",
        mimeType: "image/png",
        dataBase64: `${"A".repeat(14 * 1024 * 1024)}!`,
      },
      { dataDir: root, now: () => 1_700_000_000_000, randomSuffix: () => "abc123" },
    );

    expect(result).toMatchObject({
      success: false,
      error: "图片超过 10MB 限制",
      errorCode: "UNKNOWN",
    });
  });

  it("rejects session ids that would write outside the data directory", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "../outside",
        mimeType: "image/png",
        dataBase64: "AQID",
      },
      { dataDir: root, now: () => 1_700_000_000_000, randomSuffix: () => "abc123" },
    );

    expect(result).toMatchObject({
      success: false,
      error: "会话路径无效",
      errorCode: "UNKNOWN",
    });
    expect(existsSync(join(root, "..", "outside"))).toBe(false);
  });
});
