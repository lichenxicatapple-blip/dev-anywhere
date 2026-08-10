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

  it("keeps shell-style home paths intact instead of matching from the slash", () => {
    expect(extractImagePreviewPaths("open ~/MyApps/project/comparison.jpg")).toEqual([
      "~/MyApps/project/comparison.jpg",
    ]);
  });

  it("keeps spaces inside paths that have an explicit directory boundary", () => {
    expect(
      extractImagePreviewPaths(
        "preview @/Users/cat/My Project/final shot.png and ./review assets/second image.webp",
      ),
    ).toEqual(["/Users/cat/My Project/final shot.png", "./review assets/second image.webp"]);
    expect(extractImagePreviewPaths("open docs/My Images/comparison final.jpg now")).toEqual([
      "docs/My Images/comparison final.jpg",
    ]);
    expect(extractImagePreviewPaths("preview @final shot.png now")).toEqual(["final shot.png"]);
  });

  it("supports Unicode directory and image names", () => {
    expect(extractImagePreviewPaths("查看 @/Users/cat/项目 素材/最终 截图.png，然后继续")).toEqual([
      "/Users/cat/项目 素材/最终 截图.png",
    ]);
    expect(extractImagePreviewPaths("打开 docs/设计稿/登录页.webp")).toEqual([
      "docs/设计稿/登录页.webp",
    ]);
  });

  it("does not absorb prose before a bare image filename just because it contains spaces", () => {
    expect(extractImagePreviewPaths("please inspect final.png when ready")).toEqual(["final.png"]);
  });

  it("rejects version-shaped tokens even with image-looking suffix", () => {
    // `.0` 可以是合法扩展但 stem `5` 长度 1 -> reject
    expect(isImagePreviewPath("5.0")).toBe(false);
  });

  it("ignores unsupported image-like or remote paths", () => {
    expect(isImagePreviewPath("https://example.com/a.png")).toBe(false);
    expect(isImagePreviewPath("diagram.svg")).toBe(false);
    expect(extractImagePreviewPaths("notes.txt archive.png.bak")).toEqual([]);
    expect(extractImagePreviewPaths("git@github.com:org/repo.png")).toEqual([]);
    expect(isImagePreviewPath("github.com:org/repo.png")).toBe(false);
  });

  it("isImagePreviewPath accepts each explicit prefix directly", () => {
    expect(isImagePreviewPath("/a.png")).toBe(true);
    expect(isImagePreviewPath("./a.png")).toBe(true);
    expect(isImagePreviewPath("../a.png")).toBe(true);
    expect(isImagePreviewPath("~/a.png")).toBe(true);
    expect(isImagePreviewPath(".dev-anywhere/x.png")).toBe(true);
    expect(isImagePreviewPath("custom-cache/a.png")).toBe(true);
  });

  it("does not extend a match across non-ASCII text into a later @path token", () => {
    // 中文里夹 ASCII 单词 (logo) 会触发 regex 起始点; 严格白名单字符集不放行中文,
    // lazy 不能把整段中文 + @ 都吞进 link, 链接范围只限于真正的 @./...png。
    expect(
      extractImagePreviewPaths(
        "小logo好像没把我们的logo内容展示全，参考截图@./.dev-anywhere/clipboard/sid/foo.png",
      ),
    ).toEqual(["./.dev-anywhere/clipboard/sid/foo.png"]);
    expect(
      extractImagePreviewPaths("中文 @/var/folders/abc/T/dev-anywhere/paste-A7Bx9k.png 末尾"),
    ).toEqual(["/var/folders/abc/T/dev-anywhere/paste-A7Bx9k.png"]);
  });
});
