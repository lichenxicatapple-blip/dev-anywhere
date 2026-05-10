import { describe, expect, it } from "vitest";
import { xtermTheme } from "./xterm-theme";

describe("xtermTheme", () => {
  it("keeps the PTY cursor visible against the terminal background", () => {
    // 真实的不变量：cursor 与 background 必须不同色，cursorAccent 必须等于 background
    // 让光标内圈 (accent) 与背景融合形成"挖空"视觉。toBeTruthy 只能挡 undefined / 空字符串，
    // 不能挡 cursor === background 这种最致命的回归。
    expect(xtermTheme.cursor).not.toBe(xtermTheme.background);
    expect(xtermTheme.cursorAccent).toBe(xtermTheme.background);
  });
});
