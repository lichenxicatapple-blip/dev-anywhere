import { describe, expect, it } from "vitest";
import { formatRemotePath } from "./format-remote-path";

describe("formatRemotePath", () => {
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
    ["C:\\Users\\dev\\Documents\\app\\src", "C:\\Users\\dev", "~\\Documents\\app\\src"],
    ["~/Documents/app/", "C:\\Users\\dev", "~\\Documents\\app"],
    ["C:\\", "", "C:\\"],
    ["\\\\server\\share\\", "", "\\\\server\\share\\"],
    ["\\\\SERVER\\users\\DEV\\app", "\\\\server\\users\\dev", "~\\app"],
    [
      "\\\\server\\share\\projects\\folder\\app\\src",
      "",
      "\\\\server\\share\\projects\\folder\\app\\src",
    ],
    ["/home/dev/projects/sample-app/", "/home/dev", "~/projects/sample-app"],
    [
      "/home/dev/projects/dev-anywhere/apps/proxy",
      "/home/dev",
      "~/projects/dev-anywhere/apps/proxy",
    ],
    ["~/sample-app/", "", "~/sample-app"],
    ["~", "", "~"],
    ["/", "", "/"],
    ["/tmp/project/", "", "/tmp/project"],
    ["Release \\ QA", "C:\\Users\\dev", "Release \\ QA"],
    ["~draft", "/home/dev", "~draft"],
    ["./output/index.html", "/home/dev", "./output/index.html"],
    ["http://localhost:5173/home/dev", "/home/dev", "http://localhost:5173/home/dev"],
    ["", "/home/dev", ""],
  ])("displays %s using only the reported home %s", (path, home, expected) => {
    expect(formatRemotePath(path, home)).toBe(expected);
  });

  it.each([
    ["/home/dev/projects/dev-anywhere/apps/proxy/", "/home/dev", "~/…/apps/proxy"],
    ["C:\\Users\\dev\\Documents\\app\\src", "C:\\Users\\dev", "~\\…\\app\\src"],
    ["\\\\server\\share\\projects\\folder\\app\\src", "", "\\\\server\\share\\…\\app\\src"],
    ["/var/www/project/output/index.html", "/home/dev", "/…/output/index.html"],
    ["/home/dev/projects/app", "/home/dev", "~/projects/app"],
  ])("folds middle directories only when requested: %s", (path, home, expected) => {
    expect(formatRemotePath(path, home, { compact: true })).toBe(expected);
  });
});
