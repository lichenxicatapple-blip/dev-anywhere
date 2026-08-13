import { describe, expect, it } from "vitest";
import { isOnlyPtyNonTypingInput } from "./pty-non-typing-input";

describe("isOnlyPtyNonTypingInput", () => {
  it("detects complete SGR mouse reports, including batched press and release", () => {
    expect(isOnlyPtyNonTypingInput("\x1b[<0;18;10M")).toBe(true);
    expect(isOnlyPtyNonTypingInput("\x1b[<4;18;10M\x1b[<4;18;10m")).toBe(true);
  });

  it("detects legacy X10 and urxvt mouse reports", () => {
    expect(isOnlyPtyNonTypingInput("\x1b[M !!")).toBe(true);
    expect(isOnlyPtyNonTypingInput("\x1b[32;18;10M")).toBe(true);
  });

  it("does not classify incomplete or mixed mouse input as non-typing", () => {
    expect(isOnlyPtyNonTypingInput("\x1b[<0;18;10")).toBe(false);
    expect(isOnlyPtyNonTypingInput("\x1b[<0;18;10Ma")).toBe(false);
  });
  it("accepts terminal focus reports without classifying them as typing", () => {
    expect(isOnlyPtyNonTypingInput("\x1b[I")).toBe(true);
    expect(isOnlyPtyNonTypingInput("\x1b[O")).toBe(true);
    expect(isOnlyPtyNonTypingInput("\x1b[O\x1b[I")).toBe(true);
  });

  it("accepts mixed mouse and focus protocol reports", () => {
    expect(isOnlyPtyNonTypingInput("\x1b[<0;18;10M\x1b[O")).toBe(true);
  });

  it("does not swallow keyboard input or partial protocol reports", () => {
    expect(isOnlyPtyNonTypingInput("a")).toBe(false);
    expect(isOnlyPtyNonTypingInput("\r")).toBe(false);
    expect(isOnlyPtyNonTypingInput("\x1b[A")).toBe(false);
    expect(isOnlyPtyNonTypingInput("\x1b[Oa")).toBe(false);
    expect(isOnlyPtyNonTypingInput("\x1b[")).toBe(false);
  });
});
