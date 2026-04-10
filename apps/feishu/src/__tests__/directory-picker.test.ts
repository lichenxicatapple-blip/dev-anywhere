import { describe, it, expect } from "vitest";
import {
  buildBreadcrumbSegments,
  buildParentPath,
  joinPath,
} from "@/components/directory-picker/path-utils";

describe("buildBreadcrumbSegments", () => {
  it("returns single root segment for /", () => {
    expect(buildBreadcrumbSegments("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("returns 4 segments for /home/user/project", () => {
    const result = buildBreadcrumbSegments("/home/user/project");
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ label: "/", path: "/" });
    expect(result[1]).toEqual({ label: "home", path: "/home" });
    expect(result[2]).toEqual({ label: "user", path: "/home/user" });
    expect(result[3]).toEqual({ label: "project", path: "/home/user/project" });
  });

});

describe("buildParentPath", () => {
  it("returns /home/user for /home/user/project", () => {
    expect(buildParentPath("/home/user/project")).toBe("/home/user");
  });

  it("returns / for /", () => {
    expect(buildParentPath("/")).toBe("/");
  });

  it("returns / for single-level path /home", () => {
    expect(buildParentPath("/home")).toBe("/");
  });
});

describe("joinPath", () => {
  it("joins /home/user and subdir correctly", () => {
    expect(joinPath("/home/user", "subdir")).toBe("/home/user/subdir");
  });

  it("handles root base path correctly", () => {
    expect(joinPath("/", "home")).toBe("/home");
  });
});
