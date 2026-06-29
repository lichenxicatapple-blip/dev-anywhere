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

  it("keeps shell-style home paths intact instead of matching from the slash", () => {
    expect(extractFileDownloadPaths("download ~/MyApps/project/out.tar.gz")).toEqual([
      "~/MyApps/project/out.tar.gz",
    ]);
  });

  it("strips leading @ and trailing punctuation like image-preview-path", () => {
    expect(extractFileDownloadPaths("attached @/tmp/log.txt, see")).toEqual(["/tmp/log.txt"]);
    expect(extractFileDownloadPaths("read /var/data/notes.md.")).toEqual(["/var/data/notes.md"]);
  });

  it("excludes image extensions so image-preview link provider can claim them", () => {
    expect(extractFileDownloadPaths("/tmp/shot.png and /tmp/log.txt")).toEqual(["/tmp/log.txt"]);
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

  it("rejects display-truncated paths with ellipsis path segments", () => {
    expect(extractFileDownloadPaths("apps/proxy/.../osc-extractor.test.ts")).toEqual([]);
    expect(extractFileDownloadPaths("packages/shared/.../relay-control.test.ts")).toEqual([]);
    expect(isFileDownloadPath("apps/web/.../pty-scroll.test.ts")).toBe(false);
  });

  it("dedupes repeated paths", () => {
    expect(extractFileDownloadPaths("/a.log /a.log /a.log")).toEqual(["/a.log"]);
  });

  it("matches double-extension archives and TS/JS source files", () => {
    expect(extractFileDownloadPaths("Created ./build/out.tar.gz")).toEqual(["./build/out.tar.gz"]);
    expect(extractFileDownloadPaths("see ../dist/bundle.min.js end")).toEqual([
      "../dist/bundle.min.js",
    ]);
    expect(extractFileDownloadPaths("declared in /pkg/types/index.d.ts.")).toEqual([
      "/pkg/types/index.d.ts",
    ]);
    expect(extractFileDownloadPaths(".dev-anywhere/uploads/s1/dump.tar.bz2")).toEqual([
      ".dev-anywhere/uploads/s1/dump.tar.bz2",
    ]);
    // 三段及以上扩展: 主干 greedy 延伸到下一空白前, 扩展子表达式回溯到最末段。
    expect(extractFileDownloadPaths("see ./a/fixture.test.snapshot.json end")).toEqual([
      "./a/fixture.test.snapshot.json",
    ]);
  });

  it("recognizes explicit paths and well-known top-level project filenames", () => {
    expect(extractFileDownloadPaths("see README.md")).toEqual(["README.md"]);
    expect(extractFileDownloadPaths("edit package.json next")).toEqual(["package.json"]);
    expect(extractFileDownloadPaths("docs/superpowers/specs/2026-05-10-spec.md is")).toEqual([]);
    expect(extractFileDownloadPaths("./docs/superpowers/specs/2026-05-10-spec.md is")).toEqual([
      "./docs/superpowers/specs/2026-05-10-spec.md",
    ]);
    expect(
      extractFileDownloadPaths("- pa_break_analysis/SKILL.md 里的完整路径在哪里"),
    ).toEqual([]);
    expect(extractFileDownloadPaths("./pa_break_analysis/SKILL.md 里的完整路径在哪里")).toEqual([
      "./pa_break_analysis/SKILL.md",
    ]);
    expect(
      extractFileDownloadPaths(
        "/Users/admin/workspace/MaoGe-PTS/python/analyzer/skills/pa_break_analysis/SKILL.md",
      ),
    ).toEqual([
      "/Users/admin/workspace/MaoGe-PTS/python/analyzer/skills/pa_break_analysis/SKILL.md",
    ]);
  });

  it("rejects bare dotted identifiers that look like API symbols", () => {
    expect(extractFileDownloadPaths("schema + json.loads")).toEqual([]);
    expect(extractFileDownloadPaths("schema.json without a path signal")).toEqual([]);
    expect(isFileDownloadPath("json.loads")).toBe(false);
    expect(isFileDownloadPath("foo.bar")).toBe(false);
    expect(isFileDownloadPath("docs/foo.bar")).toBe(false);
  });

  it("rejects version-number-shaped tokens that incidentally match path syntax", () => {
    expect(isFileDownloadPath("5.0")).toBe(false);
    expect(isFileDownloadPath("1.2.3")).toBe(false);
    expect(extractFileDownloadPaths("User-Agent: Mozilla/5.0 (Macintosh)")).toEqual([]);
    expect(extractFileDownloadPaths("Node 22.4.0 release notes")).toEqual([]);
  });

  it("isFileDownloadPath accepts each explicit prefix directly", () => {
    expect(isFileDownloadPath("/a.log")).toBe(true);
    expect(isFileDownloadPath("./a.log")).toBe(true);
    expect(isFileDownloadPath("../a.log")).toBe(true);
    expect(isFileDownloadPath("~/a.log")).toBe(true);
    expect(isFileDownloadPath(".dev-anywhere/x.log")).toBe(true);
  });

  it("does not extend a match across non-ASCII text into a later @path token", () => {
    // 跟 image-preview-path 同样的失误形态: 中文里夹 ASCII 单词触发 regex 起始,
    // greedy 主干吞过中文到尾部 .ext, 把整段中文框成 link。严格白名单字符集挡住中文。
    expect(
      extractFileDownloadPaths(
        "中文 logo notes 备注 @/var/folders/abc/T/dev-anywhere/up-A7Bx9k.txt 末尾",
      ),
    ).toEqual(["/var/folders/abc/T/dev-anywhere/up-A7Bx9k.txt"]);
  });

  it("rejects scp-like git remotes", () => {
    expect(
      extractFileDownloadPaths("git@github.com:lichenxicatapple-blip/llm-proxy-client.git"),
    ).toEqual([]);
    expect(extractFileDownloadPaths("remote github.com:org/repo.git")).toEqual([]);
    expect(isFileDownloadPath("git@github.com:org/repo.git")).toBe(false);
  });
});
