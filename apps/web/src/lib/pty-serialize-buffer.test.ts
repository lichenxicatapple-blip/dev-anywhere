import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { serializeTerminalBuffer } from "./pty-serialize-buffer";

function createTerminal(lines: Array<string | null>): Terminal {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (idx: number) => {
          const text = lines[idx];
          if (text === null) return undefined;
          return {
            translateToString: (trim: boolean) => (trim ? text.trimEnd() : text),
          };
        },
      },
    },
  } as unknown as Terminal;
}

describe("serializeTerminalBuffer", () => {
  it("joins each row with a newline and trims trailing spaces per row", () => {
    const term = createTerminal(["hello   ", "world  ", "$ "]);
    expect(serializeTerminalBuffer(term)).toBe("hello\nworld\n$");
  });

  it("renders missing rows as empty strings without crashing", () => {
    const term = createTerminal(["alpha", null, "beta"]);
    expect(serializeTerminalBuffer(term)).toBe("alpha\n\nbeta");
  });

  it("returns an empty string for an empty buffer", () => {
    const term = createTerminal([]);
    expect(serializeTerminalBuffer(term)).toBe("");
  });
});
