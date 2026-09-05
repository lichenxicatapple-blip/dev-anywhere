import { describe, expect, it } from "vitest";
import {
  joinRemoteChildDirectory,
  normalizeRemoteAbsolutePath,
  remoteParentDirectory,
  resolveRemotePath,
  withTrailingSeparator,
} from "./remote-path";

describe("remote paths", () => {
  it.each([
    ["/", "/"],
    ["/home/dev/../app/", "/home/app"],
    ["/home/a\\b", "/home/a\\b"],
    ["C:\\", "C:\\"],
    ["c:/Users/dev/../app/", "C:\\Users\\app"],
    ["C:\\..\\..\\app", "C:\\app"],
    ["\\\\server\\share", "\\\\server\\share\\"],
    ["\\\\server\\share\\..\\..\\app", "\\\\server\\share\\app"],
    ["//server/share/folder", "\\\\server\\share\\folder"],
  ])("normalizes %s independently of the browser OS", (path, expected) => {
    expect(normalizeRemoteAbsolutePath(path)).toBe(expected);
  });

  it.each(["", "./app", "C:app", "C:", "\\app", "\\\\server", "x\0y"])(
    "rejects non-absolute or invalid input %j",
    (path) => expect(normalizeRemoteAbsolutePath(path)).toBe(""),
  );

  it.each([
    ["/home/dev", "/home"],
    ["/", "/"],
    ["C:\\Users", "C:\\"],
    ["C:\\", "C:\\"],
    ["\\\\server\\share\\app", "\\\\server\\share\\"],
    ["\\\\server\\share\\", "\\\\server\\share\\"],
  ])("keeps parent navigation inside the root of %s", (path, expected) => {
    expect(remoteParentDirectory(path)).toBe(expected);
  });

  it("resolves relative paths while rejecting drive-relative paths", () => {
    expect(resolveRemotePath("/home/dev", "./app")).toBe("/home/dev/app");
    expect(resolveRemotePath("C:\\Users\\dev", "..\\app")).toBe("C:\\Users\\app");
    expect(resolveRemotePath("C:\\Users\\dev", "D:/app")).toBe("D:\\app");
    expect(resolveRemotePath("\\\\server\\share\\app", "..\\..")).toBe("\\\\server\\share\\");
    expect(resolveRemotePath("C:\\Users\\dev", "C:app")).toBe("");
    expect(resolveRemotePath("C:\\Users\\dev", "\\app")).toBe("");
  });

  it("uses the remote base to disambiguate POSIX double slashes and Windows root-relative paths", () => {
    expect(resolveRemotePath("/home/dev", "//home/dev/site")).toBe("/home/dev/site");
    expect(normalizeRemoteAbsolutePath("//home/dev/site", "/home/dev")).toBe("/home/dev/site");
    expect(remoteParentDirectory("//home/dev/site", "/home/dev")).toBe("/home/dev");
    expect(resolveRemotePath("D:\\Projects", "/site")).toBe("D:\\site");
    expect(resolveRemotePath("D:\\Projects", "/")).toBe("D:\\");
    expect(resolveRemotePath("\\\\server\\share\\project", "/site")).toBe(
      "\\\\server\\share\\site",
    );
    expect(resolveRemotePath("\\\\server\\share\\project", "/../site")).toBe(
      "\\\\server\\share\\site",
    );
    expect(resolveRemotePath("D:\\Projects", "//other/share/site")).toBe("\\\\other\\share\\site");
  });

  it("joins a newly created directory without allowing another root or traversal", () => {
    expect(joinRemoteChildDirectory("/home/dev", "app/site")).toBe("/home/dev/app/site");
    expect(joinRemoteChildDirectory("C:\\Users\\dev", "app\\site")).toBe(
      "C:\\Users\\dev\\app\\site",
    );
    expect(joinRemoteChildDirectory("\\\\server\\share\\", "app")).toBe("\\\\server\\share\\app");
    for (const child of ["../app", "..\\app", "D:app", "D:\\app", "\\\\server\\share"]) {
      expect(joinRemoteChildDirectory("C:\\Users\\dev", child)).toBeNull();
    }
    expect(withTrailingSeparator("C:\\")).toBe("C:\\");
    expect(withTrailingSeparator("/home/dev")).toBe("/home/dev/");
    expect(withTrailingSeparator("app/", "C:\\project")).toBe("app\\");
    expect(joinRemoteChildDirectory("/home/dev", "app/")).toBe("/home/dev/app");
  });
});
