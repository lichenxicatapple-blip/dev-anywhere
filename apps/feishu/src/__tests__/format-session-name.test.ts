import { describe, it, expect } from "vitest";
import { formatSessionName } from "@/utils/format-session-name";

describe("formatSessionName", () => {
  it("returns 'New Session' for undefined", () => {
    expect(formatSessionName(undefined)).toBe("New Session");
  });

  it("returns 'New Session' for empty string", () => {
    expect(formatSessionName("")).toBe("New Session");
  });

  it("returns non-path strings as-is", () => {
    expect(formatSessionName("My Task")).toBe("My Task");
  });

  it("keeps short ~ paths as-is", () => {
    expect(formatSessionName("~/my-project")).toBe("~/my-project");
  });

  it("truncates long ~ paths to last 2 levels", () => {
    expect(formatSessionName("~/workspace/cc_anywhere/apps/proxy")).toBe("~/…/apps/proxy");
  });

  it("keeps short absolute paths as-is", () => {
    expect(formatSessionName("/tmp/test")).toBe("/tmp/test");
  });

  it("truncates long absolute paths", () => {
    expect(formatSessionName("/var/lib/some/deep/path")).toBe("/…/deep/path");
  });

  it("keeps 3-level ~ path without truncation", () => {
    expect(formatSessionName("~/workspace/project")).toBe("~/workspace/project");
  });

  it("handles ~ alone", () => {
    expect(formatSessionName("~")).toBe("~");
  });
});
