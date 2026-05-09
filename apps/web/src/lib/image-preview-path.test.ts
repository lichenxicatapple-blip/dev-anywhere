import { describe, expect, it } from "vitest";
import { extractImagePreviewPaths, isImagePreviewPath } from "./image-preview-path";

describe("image preview path detection", () => {
  it("detects project, temp, and pasted image path tokens", () => {
    expect(
      extractImagePreviewPaths(
        "see @.dev-anywhere/clipboard/s1/shot.png and ./tmp/render.webp plus /tmp/a.jpg",
      ),
    ).toEqual([".dev-anywhere/clipboard/s1/shot.png", "./tmp/render.webp", "/tmp/a.jpg"]);
  });

  it("trims punctuation around paths", () => {
    expect(extractImagePreviewPaths("打开 (@./screenshots/a.png), then `/tmp/b.jpeg`.")).toEqual([
      "./screenshots/a.png",
      "/tmp/b.jpeg",
    ]);
  });

  it("ignores unsupported image-like or remote paths", () => {
    expect(isImagePreviewPath("https://example.com/a.png")).toBe(false);
    expect(isImagePreviewPath("diagram.svg")).toBe(false);
    expect(extractImagePreviewPaths("notes.txt archive.png.bak")).toEqual([]);
  });
});
