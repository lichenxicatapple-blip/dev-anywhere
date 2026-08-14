import type { IBuffer } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import { findLiveScreenLastNonEmptyRow } from "./pty-xterm-metrics";

function createBuffer(lines: Record<number, string>): IBuffer {
  return {
    baseY: 100,
    viewportY: 80,
    length: 124,
    getLine: vi.fn((index: number) => {
      const value = lines[index];
      return value === undefined
        ? undefined
        : ({ translateToString: () => value } as ReturnType<IBuffer["getLine"]>);
    }),
  } as unknown as IBuffer;
}

describe("findLiveScreenLastNonEmptyRow", () => {
  it("scans the live screen from baseY even when viewportY is reviewing history", () => {
    const buffer = createBuffer({
      83: "historical output",
      107: "live prompt",
    });

    expect(findLiveScreenLastNonEmptyRow(buffer, 24)).toBe(7);
    expect(buffer.getLine).not.toHaveBeenCalledWith(83);
  });

  it("ignores whitespace-only rows and returns -1 for an empty live screen", () => {
    expect(findLiveScreenLastNonEmptyRow(createBuffer({ 123: "   " }), 24)).toBe(-1);
  });
});
