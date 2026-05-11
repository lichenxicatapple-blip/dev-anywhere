import { describe, expect, it } from "vitest";
import { extractFileDownloadPaths, isFileDownloadPath } from "./file-download-path";

describe("file-download-path extraction", () => {
  it("matches absolute / relative / .dev-anywhere paths with extensions", () => {
    expect(extractFileDownloadPaths("see /tmp/build.log")).toEqual(["/tmp/build.log"]);
    expect(extractFileDownloadPaths("./reports/2026.csv")).toEqual(["./reports/2026.csv"]);
    expect(extractFileDownloadPaths("../shared/config.json done")).toEqual([
      "../shared/config.json",
    ]);
    expect(extractFileDownloadPaths(".dev-anywhere/uploads/s1/diff.txt")).toEqual([
      ".dev-anywhere/uploads/s1/diff.txt",
    ]);
  });

  it("strips leading @ and trailing punctuation like image-preview-path", () => {
    expect(extractFileDownloadPaths("attached @/tmp/log.txt, see")).toEqual(["/tmp/log.txt"]);
    expect(extractFileDownloadPaths("read /var/data/notes.md.")).toEqual(["/var/data/notes.md"]);
  });

  it("excludes image extensions so image-preview link provider can claim them", () => {
    expect(extractFileDownloadPaths("/tmp/shot.png and /tmp/log.txt")).toEqual([
      "/tmp/log.txt",
    ]);
    expect(isFileDownloadPath("./pic.jpeg")).toBe(false);
    expect(isFileDownloadPath("./pic.gif")).toBe(false);
    expect(isFileDownloadPath("./pic.webp")).toBe(false);
  });

  it("rejects URLs", () => {
    expect(extractFileDownloadPaths("https://example.com/file.txt")).toEqual([]);
  });

  it("rejects bare directories without extension", () => {
    expect(extractFileDownloadPaths("/Users/cat /tmp")).toEqual([]);
    expect(extractFileDownloadPaths("./src/components")).toEqual([]);
  });

  it("dedupes repeated paths", () => {
    expect(extractFileDownloadPaths("/a.log /a.log /a.log")).toEqual(["/a.log"]);
  });
});
