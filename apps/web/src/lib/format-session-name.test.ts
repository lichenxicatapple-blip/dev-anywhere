import { describe, expect, it } from "vitest";
import { formatSessionName } from "./format-session-name";

describe("formatSessionName", () => {
  it("renders the same directory with or without a trailing slash", () => {
    expect(formatSessionName("/home/dev/projects/sample-app")).toBe("~/projects/sample-app");
    expect(formatSessionName("/home/dev/projects/sample-app/")).toBe("~/projects/sample-app");
    expect(formatSessionName("~/sample-app/")).toBe("~/sample-app");
  });

  it("preserves root while trimming redundant trailing slashes", () => {
    expect(formatSessionName("/")).toBe("/");
    expect(formatSessionName("/tmp/project/")).toBe("/tmp/project");
  });

  it("shortens long paths after display normalization", () => {
    expect(formatSessionName("/home/dev/projects/dev-anywhere/apps/proxy/")).toBe("~/…/apps/proxy");
  });
});
