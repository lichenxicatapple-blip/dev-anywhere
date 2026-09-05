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

  it("browses a Windows Home, another drive, and UNC shares", () => {
    const baseCwd = "C:\\Users\\dev";
    expect(resolvePickerTarget("", "select", { baseCwd })).toEqual({
      currentPath: `${baseCwd}\\`,
      query: "",
    });
    expect(resolvePickerTarget("D:\\", "select", { baseCwd })).toEqual({
      currentPath: "D:\\",
      query: "",
    });
    expect(resolvePickerTarget("C:/Users/dev/app", "select", { baseCwd })).toEqual({
      currentPath: `${baseCwd}\\`,
      query: "app",
    });
    expect(resolvePickerTarget("\\\\server\\share\\", "select", { baseCwd })).toEqual({
      currentPath: "\\\\server\\share\\",
      query: "",
    });
    expect(resolvePickerTarget("C:app", "select", { baseCwd })).toEqual({
      currentPath: "",
      query: "",
    });
  });

  it("keeps ambiguous rooted input on the remote platform and root", () => {
    expect(resolvePickerTarget("//home/dev/site", "select", { baseCwd: "/home/dev" })).toEqual({
      currentPath: "/home/dev/",
      query: "site",
    });
    expect(resolvePickerTarget("/site", "select", { baseCwd: "D:\\Projects" })).toEqual({
      currentPath: "D:\\",
      query: "site",
    });
    expect(
      resolvePickerTarget("/site", "select", { baseCwd: "\\\\server\\share\\project" }),
    ).toEqual({ currentPath: "\\\\server\\share\\", query: "site" });
  });

  it("parses Windows insert-mode separators without changing POSIX backslash names", () => {
    expect(resolvePickerTarget("@app\\so", "insert", { baseCwd: "C:\\project" })).toEqual({
      currentPath: "app\\",
      query: "so",
    });
    expect(resolvePickerTarget("@app\\so", "insert", { baseCwd: "/project" })).toEqual({
      currentPath: "./",
      query: "app\\so",
    });
  });
});
