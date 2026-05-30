import { describe, expect, it } from "vitest";
import {
  XTERM_ANSI16_COLOR_PROFILE,
  XTERM_TERMINAL_PROFILE,
  xtermFixedDarkTheme,
} from "./xterm-theme";

describe("xterm themes", () => {
  it("documents the fixed terminal profile separately from the ANSI palette profile", () => {
    expect(XTERM_TERMINAL_PROFILE).toBe("fixed-dark");
    expect(XTERM_ANSI16_COLOR_PROFILE).toBe("vscode-dark-plus");
  });

  it("keeps the PTY cursor visible against the terminal background", () => {
    const theme = xtermFixedDarkTheme;
    // 真实的不变量：cursor 与 background 必须不同色，cursorAccent 必须等于 background
    // 让光标内圈 (accent) 与背景融合形成"挖空"视觉。toBeTruthy 只能挡 undefined / 空字符串，
    // 不能挡 cursor === background 这种最致命的回归。
    expect(theme.cursor).not.toBe(theme.background);
    expect(theme.cursorAccent).toBe(theme.background);
  });
});
