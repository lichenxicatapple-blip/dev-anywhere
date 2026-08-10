import { describe, expect, it } from "vitest";
import { resolvePtySelectionPathAction } from "./pty-selection-path-action";

describe("resolvePtySelectionPathAction", () => {
  it("resolves a selected image path as preview action", () => {
    expect(resolvePtySelectionPathAction("b.jpg")).toEqual({
      kind: "image-preview",
      path: "b.jpg",
    });
  });

  it("resolves a selected downloadable file path", () => {
    expect(resolvePtySelectionPathAction("@./build/out.tar.gz")).toEqual({
      kind: "file-download",
      path: "./build/out.tar.gz",
    });
  });

  it("resolves selected paths containing spaces and Unicode", () => {
    expect(resolvePtySelectionPathAction("/Users/cat/项目 素材/最终 截图.png")).toEqual({
      kind: "image-preview",
      path: "/Users/cat/项目 素材/最终 截图.png",
    });
    expect(resolvePtySelectionPathAction("docs/项目 文档/发布 说明.md")).toEqual({
      kind: "file-download",
      path: "docs/项目 文档/发布 说明.md",
    });
  });

  it("ignores selections that merely contain a path among other text", () => {
    expect(resolvePtySelectionPathAction("artifact ./build/out.tar.gz ready")).toBeNull();
  });

  it("does not treat selected bare domains or version numbers as files", () => {
    expect(resolvePtySelectionPathAction("example.com")).toBeNull();
    expect(resolvePtySelectionPathAction("5.0")).toBeNull();
  });
});
