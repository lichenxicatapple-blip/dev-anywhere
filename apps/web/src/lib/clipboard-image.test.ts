import { describe, expect, it } from "vitest";
import {
  clipboardImagePathMention,
  getClipboardFiles,
  insertTextAtSelection,
} from "./clipboard-image";

describe("clipboard image helpers", () => {
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

describe("getClipboardFiles", () => {
  it("prefers all files without reading duplicate item representations", () => {
    const files = [
      new File(["image"], "photo.png", { type: "image/png" }),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    ];
    expect(
      getClipboardFiles({
        files,
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => {
              throw new Error("duplicate items must not be read");
            },
          },
        ],
      }),
    ).toEqual(files);
  });

  it("falls back to every file item, ignoring strings and unavailable files", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });
    const document = new File(["data"], "document.bin");
    expect(
      getClipboardFiles({
        files: [],
        items: [
          { kind: "string", type: "text/plain", getAsFile: () => null },
          { kind: "file", type: image.type, getAsFile: () => image },
          { kind: "file", type: "", getAsFile: () => null },
          { kind: "file", type: "", getAsFile: () => document },
        ],
      }),
    ).toEqual([image, document]);
  });

  it("preserves separate same-name files in order", () => {
    const files = [new File(["first"], "image.png"), new File(["second"], "image.png")];
    const result = getClipboardFiles({ files });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(files[0]);
    expect(result[1]).toBe(files[1]);
  });

  it("returns no files for empty or missing clipboard data", () => {
    expect(getClipboardFiles(null)).toEqual([]);
    expect(getClipboardFiles({})).toEqual([]);
    expect(getClipboardFiles({ files: [], items: [] })).toEqual([]);
  });
});
