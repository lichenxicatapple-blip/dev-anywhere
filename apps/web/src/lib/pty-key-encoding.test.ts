import { describe, expect, it } from "vitest";
import { encodePtyInputForTerminalModes } from "./pty-key-encoding";

describe("encodePtyInputForTerminalModes", () => {
  it("keeps normal CSI cursor keys at a shell prompt", () => {
    for (const data of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]) {
      expect(encodePtyInputForTerminalModes(data, { applicationCursorKeysMode: false })).toBe(data);
    }
  });

  it("uses SS3 cursor keys when Vim enables application cursor mode", () => {
    expect(encodePtyInputForTerminalModes("\x1b[A", { applicationCursorKeysMode: true })).toBe(
      "\x1bOA",
    );
    expect(encodePtyInputForTerminalModes("\x1b[B", { applicationCursorKeysMode: true })).toBe(
      "\x1bOB",
    );
    expect(encodePtyInputForTerminalModes("\x1b[C", { applicationCursorKeysMode: true })).toBe(
      "\x1bOC",
    );
    expect(encodePtyInputForTerminalModes("\x1b[D", { applicationCursorKeysMode: true })).toBe(
      "\x1bOD",
    );
  });

  it("does not rewrite non-cursor control input", () => {
    for (const data of ["\x1b", "\t", "\x1b[Z", "\r", "h", "j", "k", "l"]) {
      expect(encodePtyInputForTerminalModes(data, { applicationCursorKeysMode: true })).toBe(data);
    }
  });
});
