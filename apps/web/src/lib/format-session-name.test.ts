import { describe, expect, it } from "vitest";
import { formatSessionName, formatUnlockedTerminalPathName } from "./format-session-name";

describe("formatSessionName", () => {
  it("renders the same directory with or without a trailing slash", () => {
    expect(formatSessionName("/home/dev/projects/sample-app", "/home/dev")).toBe(
      "~/projects/sample-app",
    );
    expect(formatSessionName("/home/dev/projects/sample-app/", "/home/dev")).toBe(
      "~/projects/sample-app",
    );
    expect(formatSessionName("~/sample-app/")).toBe("~/sample-app");
  });

  it("preserves root while trimming redundant trailing slashes", () => {
    expect(formatSessionName("/")).toBe("/");
    expect(formatSessionName("/tmp/project/")).toBe("/tmp/project");
  });

  it("shortens long paths after display normalization", () => {
    expect(formatSessionName("/home/dev/projects/dev-anywhere/apps/proxy/", "/home/dev")).toBe(
      "~/…/apps/proxy",
    );
  });

  it.each([
    ["/Users/dev", "/Users/dev/", "~"],
    ["/Users/dev/project", "/Users/dev", "~/project"],
    ["/Users/dev2/project", "/Users/dev", "/Users/dev2/project"],
    ["/home/dev/project", "/home/dev", "~/project"],
    ["/Home/dev/project", "/home/dev", "/Home/dev/project"],
    ["/home/dev/app\\notes", "/home/dev", "~/app\\notes"],
    ["/Users/dev/project", "", "/Users/dev/project"],
    ["C:\\Users\\dev", "c:/users/DEV/", "~"],
    ["c:\\USERS\\DEV\\Documents\\app", "C:\\Users\\dev", "~\\Documents\\app"],
    ["C:/Users/dev/Documents/app/", "C:\\Users\\dev", "~\\Documents\\app"],
    ["C:\\Users\\dev-other\\app", "C:\\Users\\dev", "C:\\Users\\dev-other\\app"],
    ["D:\\Users\\dev\\app", "C:\\Users\\dev", "D:\\Users\\dev\\app"],
    ["D:\\Profiles\\dev\\app", "D:\\Profiles\\dev", "~\\app"],
    ["C:\\Users\\dev\\..\\other\\app", "C:\\Users\\dev", "C:\\Users\\other\\app"],
    ["C:\\Users\\dev\\Documents\\app\\src", "C:\\Users\\dev", "~\\…\\app\\src"],
    ["~/Documents/app/", "C:\\Users\\dev", "~\\Documents\\app"],
    ["C:\\", "", "C:\\"],
    ["\\\\server\\share\\", "", "\\\\server\\share\\"],
    ["\\\\SERVER\\users\\DEV\\app", "\\\\server\\users\\dev", "~\\app"],
    ["\\\\server\\share\\projects\\folder\\app\\src", "", "\\\\server\\share\\…\\app\\src"],
    ["Release \\ QA", "C:\\Users\\dev", "Release \\ QA"],
    ["~draft", "/home/dev", "~draft"],
  ])(
    "formats %s against the reported home %s without changing path identity",
    (path, home, expected) => {
      expect(formatSessionName(path, home)).toBe(expected);
    },
  );

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
