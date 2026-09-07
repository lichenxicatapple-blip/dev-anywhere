import { describe, expect, it } from "vitest";
import { formatSessionName, formatUnlockedTerminalPathName } from "./format-session-name";

describe("formatSessionName", () => {
  it("preserves names and handles unnamed sessions separately from path display", () => {
    expect(formatSessionName(undefined)).toBe("New Session");
    expect(formatSessionName("")).toBe("New Session");
    expect(formatSessionName("Release \\ QA", "C:\\Users\\dev")).toBe("Release \\ QA");
  });

  it("shortens long paths after display normalization", () => {
    expect(formatSessionName("/home/dev/projects/dev-anywhere/apps/proxy/", "/home/dev")).toBe(
      "~/…/apps/proxy",
    );
  });

  it("formats pure terminal cwd only before user rename", () => {
    expect(
      formatUnlockedTerminalPathName(
        {
          kind: "terminal",
          name: "Terminal",
          cwd: "/home/dev/workspace",
        },
        "/home/dev",
      ),
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
