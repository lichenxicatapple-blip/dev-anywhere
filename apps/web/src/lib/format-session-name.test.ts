import { describe, expect, it } from "vitest";
import { formatSessionName } from "./format-session-name";

describe("formatSessionName", () => {
  it("renders the same directory with or without a trailing slash", () => {
    expect(formatSessionName("/Users/admin/test_go")).toBe("~/test_go");
    expect(formatSessionName("/Users/admin/test_go/")).toBe("~/test_go");
    expect(formatSessionName("~/test_go/")).toBe("~/test_go");
  });

  it("preserves root while trimming redundant trailing slashes", () => {
    expect(formatSessionName("/")).toBe("/");
    expect(formatSessionName("/tmp/project/")).toBe("/tmp/project");
  });

  it("shortens long paths after display normalization", () => {
    expect(formatSessionName("/Users/admin/workspace/dev-anywhere/apps/proxy/")).toBe(
      "~/…/apps/proxy",
    );
  });
});
