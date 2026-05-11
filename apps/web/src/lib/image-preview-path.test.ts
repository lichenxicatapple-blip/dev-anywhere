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

  it("recognizes bare image filenames and bare relative paths without explicit prefix", () => {
    expect(extractImagePreviewPaths("看看 screenshot.png")).toEqual(["screenshot.png"]);
    expect(extractImagePreviewPaths("docs/assets/diagram-a.png 这张")).toEqual([
      "docs/assets/diagram-a.png",
    ]);
  });

  it("rejects version-shaped tokens even with image-looking suffix", () => {
    // `.0` 可以是合法扩展但 stem `5` 长度 1 -> reject
    expect(isImagePreviewPath("5.0")).toBe(false);
  });

  it("ignores unsupported image-like or remote paths", () => {
    expect(isImagePreviewPath("https://example.com/a.png")).toBe(false);
    expect(isImagePreviewPath("diagram.svg")).toBe(false);
    expect(extractImagePreviewPaths("notes.txt archive.png.bak")).toEqual([]);
  });

  it("isImagePreviewPath accepts each explicit prefix directly", () => {
    expect(isImagePreviewPath("/a.png")).toBe(true);
    expect(isImagePreviewPath("./a.png")).toBe(true);
    expect(isImagePreviewPath("../a.png")).toBe(true);
    expect(isImagePreviewPath(".dev-anywhere/x.png")).toBe(true);
  });
});
