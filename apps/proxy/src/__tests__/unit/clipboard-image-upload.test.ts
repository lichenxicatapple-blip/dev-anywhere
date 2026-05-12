import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveClipboardImageUpload,
  type ClipboardImageUploadRequest,
} from "#src/serve/clipboard-image-upload.js";

describe("clipboard image upload storage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "clipboard-image-upload-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes paste-<suffix>.<ext> directly under the data dir as an absolute path", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "s1",
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      },
      { dataDir, randomSuffix: () => "abc123" },
    );

    expect(result).toEqual({
      success: true,
      path: join(dataDir, "paste-abc123.png"),
    });
    expect(existsSync(result.path!)).toBe(true);
    expect(readFileSync(result.path!)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects unsupported clipboard image MIME types", () => {
    const result = saveClipboardImageUpload(
      {
        sessionId: "s1",
        mimeType: "image/svg+xml",
        dataBase64: "PHN2Zy8+",
      } as ClipboardImageUploadRequest,
      { dataDir, randomSuffix: () => "abc123" },
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
      { dataDir, randomSuffix: () => "abc123" },
    );

    expect(result).toMatchObject({
      success: false,
      error: "图片超过 10MB 限制",
      errorCode: "UNKNOWN",
    });
  });
});
