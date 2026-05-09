import { describe, expect, it } from "vitest";
import { isOnlyPtyMouseInput } from "./pty-mouse-input";

describe("PTY mouse input detection", () => {
  it("detects SGR mouse reporting input", () => {
    expect(isOnlyPtyMouseInput("\x1b[<0;18;10M")).toBe(true);
    expect(isOnlyPtyMouseInput("\x1b[<0;18;10M\x1b[<0;18;10m")).toBe(true);
  });

  it("detects X10 and urxvt mouse reporting input", () => {
    expect(isOnlyPtyMouseInput("\x1b[M !!")).toBe(true);
    expect(isOnlyPtyMouseInput("\x1b[32;18;10M")).toBe(true);
  });

  it("does not classify keyboard or mixed input as mouse-only", () => {
    expect(isOnlyPtyMouseInput("a")).toBe(false);
    expect(isOnlyPtyMouseInput("\r")).toBe(false);
    expect(isOnlyPtyMouseInput("\x1b[A")).toBe(false);
    expect(isOnlyPtyMouseInput("\x1b[<0;18;10Ma")).toBe(false);
  });
});
