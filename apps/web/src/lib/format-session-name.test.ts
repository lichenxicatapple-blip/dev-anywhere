import { describe, expect, it } from "vitest";
import { formatSessionName, formatUnlockedTerminalPathName } from "./format-session-name";

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

  it("formats pure terminal cwd only before user rename", () => {
    expect(
      formatUnlockedTerminalPathName({
        kind: "terminal",
        name: "Terminal",
        cwd: "/home/dev/workspace",
      }),
    ).toBe("~/workspace");

    expect(
      formatUnlockedTerminalPathName({
        kind: "terminal",
        name: "Release shell",
        cwd: "/home/dev/workspace",
        nameLocked: true,
      }),
    ).toBeUndefined();
  });
});
