import { describe, expect, it } from "vitest";
import {
  extractMediaPreviewPaths,
  findMediaPreviewPathMatches,
  getMediaPreviewKind,
  isMediaPreviewPath,
} from "./media-preview-path";

describe("media preview path detection", () => {
  it.each(["mp4", "webm", "mov", "m4v", "ogv"])(
    "classifies local %s videos without changing path boundaries",
    (extension) => {
      const path = `./录屏/demo.${extension.toUpperCase()}`;
      const text = `打开 @${path}。`;
      expect(getMediaPreviewKind(path)).toBe("video");
      expect(findMediaPreviewPathMatches(text)).toEqual([
        { kind: "video", path, start: 3, end: 4 + path.length },
      ]);
      expect(extractMediaPreviewPaths(`${path} ${path}`)).toEqual([path]);
      expect(isMediaPreviewPath(`https://example.com/demo.${extension}`)).toBe(false);
      expect(extractMediaPreviewPaths(`archive.${extension}.bak`)).toEqual([]);
    },
  );

  it.each(["png", "jpg", "jpeg", "webp", "gif"])("retains %s image classification", (ext) => {
    expect(getMediaPreviewKind(`./shot.${ext}`)).toBe("image");
  });

  it("keeps video paths intact across Windows, home, and explicit local path forms", () => {
    for (const path of [String.raw`C:\录屏\demo.mp4`, "~/Movies/demo.webm", "clips/demo.mov"]) {
      expect(extractMediaPreviewPaths(`查看 @${path}`)).toEqual([path]);
    }
    expect(getMediaPreviewKind("https://example.com/demo.mp4")).toBeNull();
    expect(getMediaPreviewKind("git@github.com:org/demo.mp4")).toBeNull();
    expect(getMediaPreviewKind("demo.mkv")).toBeNull();
  });

  it.each([String.raw`.\1.png`, String.raw`C:\图片\1.png`, String.raw`\\server\share\a.jpg`])(
    "recognizes Windows image path %s",
    (path) => {
      expect(extractMediaPreviewPaths(`open ${path} next`)).toEqual([path]);
    },
  );

  it("detects project, temp, and pasted image path tokens", () => {
    expect(
      extractMediaPreviewPaths(
        "see @.dev-anywhere/clipboard/s1/shot.png and ./tmp/render.webp plus /tmp/a.jpg",
      ),
    ).toEqual([".dev-anywhere/clipboard/s1/shot.png", "./tmp/render.webp", "/tmp/a.jpg"]);
  });

  it("trims punctuation around paths", () => {
    expect(extractMediaPreviewPaths("打开 (@./screenshots/a.png), then `/tmp/b.jpeg`.")).toEqual([
      "./screenshots/a.png",
      "/tmp/b.jpeg",
    ]);
  });

  it("recognizes bare image filenames and bare relative paths without explicit prefix", () => {
    expect(extractMediaPreviewPaths("看看 screenshot.png")).toEqual(["screenshot.png"]);
    expect(extractMediaPreviewPaths("docs/assets/diagram-a.png 这张")).toEqual([
      "docs/assets/diagram-a.png",
    ]);
  });

  it("keeps shell-style home paths intact instead of matching from the slash", () => {
    expect(extractMediaPreviewPaths("open ~/MyApps/project/comparison.jpg")).toEqual([
      "~/MyApps/project/comparison.jpg",
    ]);
  });

  it("treats whitespace and newlines as hard path boundaries", () => {
    expect(extractMediaPreviewPaths("/tmp/first.png /tmp/second.webp")).toEqual([
      "/tmp/first.png",
      "/tmp/second.webp",
    ]);
    expect(extractMediaPreviewPaths("/tmp/first.png\n/tmp/second.webp")).toEqual([
      "/tmp/first.png",
      "/tmp/second.webp",
    ]);
  });

  it("supports Unicode directory and image names without whitespace", () => {
    expect(extractMediaPreviewPaths("打开 docs/设计稿/登录页.webp")).toEqual([
      "docs/设计稿/登录页.webp",
    ]);
  });

  it("does not absorb prose before a bare image filename just because it contains spaces", () => {
    expect(extractMediaPreviewPaths("please inspect final.png when ready")).toEqual(["final.png"]);
  });

  it("rejects version-shaped tokens even with image-looking suffix", () => {
    // `.0` 可以是合法扩展但 stem `5` 长度 1 -> reject
    expect(isMediaPreviewPath("5.0")).toBe(false);
  });

  it("ignores unsupported image-like or remote paths", () => {
    expect(isMediaPreviewPath("https://example.com/a.png")).toBe(false);
    expect(isMediaPreviewPath("diagram.svg")).toBe(false);
    expect(extractMediaPreviewPaths("notes.txt archive.png.bak")).toEqual([]);
    expect(extractMediaPreviewPaths("git@github.com:org/repo.png")).toEqual([]);
    expect(isMediaPreviewPath("github.com:org/repo.png")).toBe(false);
  });

  it("isMediaPreviewPath accepts each explicit prefix directly", () => {
    expect(isMediaPreviewPath("/a.png")).toBe(true);
    expect(isMediaPreviewPath("./a.png")).toBe(true);
    expect(isMediaPreviewPath("../a.png")).toBe(true);
    expect(isMediaPreviewPath("~/a.png")).toBe(true);
    expect(isMediaPreviewPath(".dev-anywhere/x.png")).toBe(true);
    expect(isMediaPreviewPath("custom-cache/a.png")).toBe(true);
  });

  it("does not extend a match across non-ASCII text into a later @path token", () => {
    // 中文里夹 ASCII 单词 (logo) 会触发 regex 起始点; 严格白名单字符集不放行中文,
    // lazy 不能把整段中文 + @ 都吞进 link, 链接范围只限于真正的 @./...png。
    expect(
      extractMediaPreviewPaths(
        "小logo好像没把我们的logo内容展示全，参考截图@./.dev-anywhere/clipboard/sid/foo.png",
      ),
    ).toEqual(["./.dev-anywhere/clipboard/sid/foo.png"]);
    expect(
      extractMediaPreviewPaths("中文 @/var/folders/abc/T/dev-anywhere/paste-A7Bx9k.png 末尾"),
    ).toEqual(["/var/folders/abc/T/dev-anywhere/paste-A7Bx9k.png"]);
  });
});
