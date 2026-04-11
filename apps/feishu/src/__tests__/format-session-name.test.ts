import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatSessionName } from "@/utils/format-session-name";

describe("formatSessionName", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, HOME: "/Users/admin" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 'New Session' for undefined", () => {
    expect(formatSessionName(undefined)).toBe("New Session");
  });

  it("returns 'New Session' for empty string", () => {
    expect(formatSessionName("")).toBe("New Session");
  });

  it("returns non-path strings as-is", () => {
    expect(formatSessionName("My Task")).toBe("My Task");
  });

  it("replaces HOME with ~ and keeps short paths", () => {
    expect(formatSessionName("/Users/admin/my-project")).toBe("~/my-project");
  });

  it("truncates long paths to last 2 levels", () => {
    expect(formatSessionName("/Users/admin/workspace/cc_anywhere/apps/proxy")).toBe("~/…/apps/proxy");
  });

  it("handles paths not under HOME", () => {
    expect(formatSessionName("/tmp/test")).toBe("/tmp/test");
  });

  it("truncates long non-HOME paths", () => {
    expect(formatSessionName("/var/lib/some/deep/path")).toBe("/…/deep/path");
  });

  it("handles HOME root", () => {
    expect(formatSessionName("/Users/admin")).toBe("~");
  });

  it("handles 3-level path under HOME without truncation", () => {
    expect(formatSessionName("/Users/admin/workspace/project")).toBe("~/workspace/project");
  });
});
