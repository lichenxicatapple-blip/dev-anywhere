import { describe, expect, it } from "vitest";
import {
  getXtermTheme,
  resolveXtermThemeName,
  xtermDarkTheme,
  xtermLightTheme,
} from "./xterm-theme";

describe("xterm themes", () => {
  it.each([
    ["dark", xtermDarkTheme],
    ["light", xtermLightTheme],
  ] as const)("keeps the %s PTY cursor visible against the terminal background", (_name, theme) => {
    // 真实的不变量：cursor 与 background 必须不同色，cursorAccent 必须等于 background
    // 让光标内圈 (accent) 与背景融合形成"挖空"视觉。toBeTruthy 只能挡 undefined / 空字符串，
    // 不能挡 cursor === background 这种最致命的回归。
    expect(theme.cursor).not.toBe(theme.background);
    expect(theme.cursorAccent).toBe(theme.background);
  });

  it("returns the requested terminal theme", () => {
    expect(getXtermTheme("dark")).toBe(xtermDarkTheme);
    expect(getXtermTheme("light")).toBe(xtermLightTheme);
  });

  it("resolves app theme preference for the terminal", () => {
    expect(resolveXtermThemeName("light", true)).toBe("light");
    expect(resolveXtermThemeName("dark", false)).toBe("dark");
    expect(resolveXtermThemeName("auto", true)).toBe("dark");
    expect(resolveXtermThemeName("auto", false)).toBe("light");
  });
});
