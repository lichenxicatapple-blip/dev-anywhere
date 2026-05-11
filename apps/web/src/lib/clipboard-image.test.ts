import { describe, expect, it, vi } from "vitest";
import {
  clipboardImagePathMention,
  fileToClipboardImagePayload,
  getClipboardImageFile,
  insertTextAtSelection,
} from "./clipboard-image";

describe("clipboard image helpers", () => {
  it("extracts the first image file from clipboard items", () => {
    const textFile = new File(["hello"], "note.txt", { type: "text/plain" });
    const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });
    const clipboardData = {
      items: [
        { kind: "file", type: "text/plain", getAsFile: () => textFile },
        { kind: "file", type: "image/png", getAsFile: () => imageFile },
      ],
      files: [],
    } as unknown as DataTransfer;

    expect(getClipboardImageFile(clipboardData)).toBe(imageFile);
  });

  it("falls back to clipboard files when items are unavailable", () => {
    const imageFile = new File([new Uint8Array([4, 5, 6])], "fallback.webp", {
      type: "image/webp",
    });
    const clipboardData = {
      files: [imageFile],
    } as unknown as DataTransfer;

    expect(getClipboardImageFile(clipboardData)).toBe(imageFile);
  });

  it("converts image files to relay upload payloads", async () => {
    const imageFile = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });

    await expect(fileToClipboardImagePayload(imageFile)).resolves.toEqual({
      fileName: "shot.png",
      mimeType: "image/png",
      dataBase64: "AQID",
    });
  });

  it("rejects oversized images before reading file bytes", async () => {
    const oversizedImage = {
      type: "image/png",
      name: "huge.png",
      size: 10 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn().mockRejectedValue(new Error("should not read oversized files")),
    } as unknown as File;

    await expect(fileToClipboardImagePayload(oversizedImage)).rejects.toThrow("图片超过 10MB 限制");
    expect(oversizedImage.arrayBuffer).not.toHaveBeenCalled();
  });

  it("inserts uploaded image path tokens at the current selection", () => {
    expect(insertTextAtSelection("ask about this", "@/tmp/shot.png ", 4, 9)).toEqual({
      value: "ask @/tmp/shot.png  this",
      cursor: 19,
    });
  });

  it("formats uploaded paths as agent file tokens", () => {
    expect(clipboardImagePathMention("/tmp/dev-anywhere/shot.png")).toBe(
      "@/tmp/dev-anywhere/shot.png ",
    );
    expect(clipboardImagePathMention("@/tmp/already-tokenized.png")).toBe(
      "@/tmp/already-tokenized.png ",
    );
  });
});
