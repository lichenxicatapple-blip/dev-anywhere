import { describe, expect, it } from "vitest";
import { resolvePickerTarget } from "./file-path-picker-target";

describe("resolvePickerTarget", () => {
  it("treats the configured home path as the directory to browse", () => {
    expect(
      resolvePickerTarget("/Users/admin", "select", {
        baseCwd: "/Users/admin",
        knownDirs: new Set(),
      }),
    ).toEqual({ currentPath: "/Users/admin/", query: "" });
  });

  it("treats known directories as directories even without a trailing slash", () => {
    expect(
      resolvePickerTarget("/Users/admin/workspace", "select", {
        baseCwd: "/Users/admin",
        knownDirs: new Set(["/Users/admin/workspace"]),
      }),
    ).toEqual({ currentPath: "/Users/admin/workspace/", query: "" });
  });

  it("keeps unfinished select input as parent path plus query", () => {
    expect(
      resolvePickerTarget("/Users/admin/work", "select", {
        baseCwd: "/Users/admin",
        knownDirs: new Set(["/Users/admin/workspace"]),
      }),
    ).toEqual({ currentPath: "/Users/admin/", query: "work" });
  });

  it("keeps insert mode anchored to the @ path segment", () => {
    expect(resolvePickerTarget("open @apps/we", "insert")).toEqual({
      currentPath: "apps/",
      query: "we",
    });
  });
});
