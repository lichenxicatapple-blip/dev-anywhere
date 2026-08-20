import type { IBufferCell, IBufferLine } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  rebasePtySelectionLineSnapshots,
  snapshotPtySelectionBufferLine,
} from "./pty-selection-buffer-snapshot";

function line(cells: Array<{ chars?: string; width?: number }>, isWrapped = false): IBufferLine {
  return {
    length: cells.length,
    isWrapped,
    getCell: (column: number) => {
      const cell = cells[column];
      if (!cell) return undefined;
      return {
        getChars: () => cell.chars ?? "",
        getWidth: () => cell.width ?? 1,
      } as unknown as IBufferCell;
    },
  } as unknown as IBufferLine;
}

describe("PTY selection line snapshot", () => {
  it("preserves explicit trailing spaces and NBSP while trimming unwritten cells", () => {
    const snapshot = snapshotPtySelectionBufferLine(
      line([{ chars: "A" }, { chars: " " }, { chars: "\u00a0" }, {}, {}]),
      5,
    );

    expect(snapshot.translateToString(true)).toBe("A \u00a0");
    expect(snapshot.translateToString(false)).toBe("A \u00a0  ");
  });

  it("keeps xterm's wide-cell and continuation translation semantics", () => {
    const snapshot = snapshotPtySelectionBufferLine(
      line([{ chars: "A" }, { chars: "中", width: 2 }, { width: 0 }, { chars: "B" }]),
      4,
    );

    expect(snapshot.getCell(1)?.getChars()).toBe("中");
    expect(snapshot.getCell(1)?.getWidth()).toBe(2);
    expect(snapshot.getCell(2)?.getWidth()).toBe(0);
    expect(snapshot.translateToString(false, 1, 3)).toBe("中");
    expect(snapshot.translateToString(false, 2, 3)).toBe(" ");
    expect(snapshot.translateToString(true)).toBe("A中B");
  });

  it("rebases immutable lines and drops rows trimmed above zero", () => {
    const first = line([{ chars: "A" }]);
    const second = line([{ chars: "B" }]);
    const rebased = rebasePtySelectionLineSnapshots(
      new Map([
        [0, first],
        [4, second],
      ]),
      -2,
    );

    expect(Array.from(rebased.entries())).toEqual([[2, second]]);
  });
});
