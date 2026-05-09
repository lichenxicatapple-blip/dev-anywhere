import { describe, expect, it } from "vitest";
import { xtermTheme } from "./xterm-theme";

describe("xtermTheme", () => {
  it("keeps the PTY cursor visible against the terminal background", () => {
    expect(xtermTheme.cursor).toBeTruthy();
    expect(xtermTheme.cursor).not.toBe(xtermTheme.background);
    expect(xtermTheme.cursorAccent).toBe(xtermTheme.background);
  });
});
