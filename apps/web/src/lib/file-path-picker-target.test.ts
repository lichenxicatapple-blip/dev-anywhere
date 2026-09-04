import { describe, expect, it } from "vitest";
import { resolvePickerTarget } from "./file-path-picker-target";

describe("resolvePickerTarget", () => {
  it("starts an empty select-mode picker from the absolute home path", () => {
    expect(
      resolvePickerTarget("", "select", {
        baseCwd: "/home/dev",
        knownDirs: new Set(),
      }),
    ).toEqual({ currentPath: "/home/dev/", query: "" });
  });

  it("treats the configured home path as the directory to browse", () => {
    expect(
      resolvePickerTarget("/home/dev", "select", {
        baseCwd: "/home/dev",
        knownDirs: new Set(),
      }),
    ).toEqual({ currentPath: "/home/dev/", query: "" });
  });

  it("treats known directories as directories even without a trailing slash", () => {
    expect(
      resolvePickerTarget("/home/dev/projects", "select", {
        baseCwd: "/home/dev",
        knownDirs: new Set(["/home/dev/projects"]),
      }),
    ).toEqual({ currentPath: "/home/dev/projects/", query: "" });
  });

  it("keeps unfinished select input as parent path plus query", () => {
    expect(
      resolvePickerTarget("/home/dev/work", "select", {
        baseCwd: "/home/dev",
        knownDirs: new Set(["/home/dev/projects"]),
      }),
    ).toEqual({ currentPath: "/home/dev/", query: "work" });
  });

  it("resolves relative select input against the absolute home path", () => {
    expect(
      resolvePickerTarget("./projects/app", "select", {
        baseCwd: "/home/dev",
        knownDirs: new Set(),
      }),
    ).toEqual({ currentPath: "/home/dev/projects/", query: "app" });
  });

  it("keeps insert mode anchored to the @ path segment", () => {
    expect(resolvePickerTarget("open @apps/we", "insert")).toEqual({
      currentPath: "apps/",
      query: "we",
    });
  });
});
