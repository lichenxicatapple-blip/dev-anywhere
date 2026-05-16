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
});
