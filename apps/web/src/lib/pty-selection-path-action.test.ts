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

  it("ignores selections that merely contain a path among other text", () => {
    expect(resolvePtySelectionPathAction("artifact ./build/out.tar.gz ready")).toBeNull();
  });

  it("does not treat selected bare domains or version numbers as files", () => {
    expect(resolvePtySelectionPathAction("example.com")).toBeNull();
    expect(resolvePtySelectionPathAction("5.0")).toBeNull();
  });
});
