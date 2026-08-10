import { describe, expect, it } from "vitest";
import { findInlinePathLinks } from "./inline-path-links";

describe("inline path link detection", () => {
  it("classifies file and image paths in source order", () => {
    expect(findInlinePathLinks("see README.md and .dev-anywhere/clipboard/s1/shot.png")).toEqual([
      { kind: "file", path: "README.md", start: 4, end: 13 },
      { kind: "image", path: ".dev-anywhere/clipboard/s1/shot.png", start: 18, end: 53 },
    ]);
  });

  it("normalizes leading @ and trims trailing punctuation", () => {
    expect(findInlinePathLinks("open @/tmp/report.json, then @./screens/a.png.")).toEqual([
      { kind: "file", path: "/tmp/report.json", start: 5, end: 22 },
      { kind: "image", path: "./screens/a.png", start: 29, end: 45 },
    ]);
  });

  it("keeps an explicitly bounded image path with spaces as one preview action", () => {
    const text = "preview @/Users/cat/My Project/final shot.png now";
    const path = "/Users/cat/My Project/final shot.png";
    const start = text.indexOf("@");
    expect(findInlinePathLinks(text)).toEqual([
      { kind: "image", path, start, end: start + path.length + 1 },
    ]);
  });

  it("keeps Unicode image and file paths as complete inline actions", () => {
    const image = "/Users/cat/项目 素材/最终 截图.png";
    const file = "docs/项目 文档/发布 说明.md";
    const text = `see @${image} and ${file}`;
    expect(findInlinePathLinks(text)).toEqual([
      { kind: "image", path: image, start: 4, end: 5 + image.length },
      {
        kind: "file",
        path: file,
        start: text.indexOf(file),
        end: text.indexOf(file) + file.length,
      },
    ]);
  });

  it("rejects URLs, version-shaped tokens, and display-truncated paths", () => {
    expect(
      findInlinePathLinks("https://example.com/file.txt Node 22.4.0 apps/web/.../x.test.ts"),
    ).toEqual([]);
  });

  it("rejects bare domains while keeping bare filenames", () => {
    expect(findInlinePathLinks("check status.claude.com and dev-anywhere.vita-tools.top")).toEqual(
      [],
    );
    expect(findInlinePathLinks("check README.md and package.json")).toEqual([
      { kind: "file", path: "README.md", start: 6, end: 15 },
      { kind: "file", path: "package.json", start: 20, end: 32 },
    ]);
  });

  it("does not turn dotted code identifiers into download actions", () => {
    expect(findInlinePathLinks("schema + json.loads")).toEqual([]);
    expect(findInlinePathLinks("call os.path.join, then inspect pathlib.Path")).toEqual([]);
  });

  it("does not split scp-like git remotes into file links", () => {
    expect(
      findInlinePathLinks("git@github.com:lichenxicatapple-blip/llm-proxy-client.git"),
    ).toEqual([]);
    expect(findInlinePathLinks("remote github.com:org/repo.git")).toEqual([]);
  });
});
