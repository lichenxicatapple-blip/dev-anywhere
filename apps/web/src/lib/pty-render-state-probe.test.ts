import { describe, expect, it } from "vitest";
import {
  clearRenderModel,
  diffModelAgainstBuffer,
  probeWebglRenderModel,
  type ProbedRenderModel,
} from "./pty-render-state-probe";
import type { Terminal } from "@xterm/xterm";

// 用 mini stub mimick xterm 接口里 diff 函数实际碰到的形状,避免真实启动 xterm。
function fakeTerminal(opts: {
  cols: number;
  rows: number;
  viewportY: number;
  // codes[absoluteY][col] = bufferCell.getCode()
  codes: number[][];
}): Terminal {
  const { cols, rows, viewportY, codes } = opts;
  return {
    cols,
    rows,
    buffer: {
      active: {
        viewportY,
        getLine(y: number) {
          const line = codes[y];
          if (!line) return undefined;
          return {
            getCell(c: number) {
              const code = line[c];
              if (code === undefined) return undefined;
              return { getCode: () => code };
            },
          };
        },
      },
    },
  } as unknown as Terminal;
}

function makeModelCells(cols: number, rows: number, codes: number[][]): Uint32Array {
  const arr = new Uint32Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      arr[(r * cols + c) * 4] = codes[r]?.[c] ?? 0;
    }
  }
  return arr;
}

describe("probeWebglRenderModel", () => {
  it("locates cells array nested 3 levels deep by Uint32Array shape", () => {
    const cols = 4;
    const rows = 2;
    const cells = new Uint32Array(cols * rows * 4);
    cells[0] = 0x41; // "A"
    const lineLengths = new Uint32Array(rows);
    const fakeAddon = {
      _renderer: {
        _model: {
          cells,
          lineLengths,
          unrelated: "ignored",
        },
      },
    };
    const probed = probeWebglRenderModel(fakeAddon, cols, rows);
    expect(probed).not.toBeNull();
    expect(probed!.cells).toBe(cells);
    expect(probed!.lineLengths).toBe(lineLengths);
    expect(probed!.cols).toBe(cols);
    expect(probed!.rows).toBe(rows);
  });

  it("returns null when no Uint32Array of expected shape exists", () => {
    const fakeAddon = { _renderer: { _model: { cells: new Uint32Array(7) } } };
    expect(probeWebglRenderModel(fakeAddon, 4, 2)).toBeNull();
  });

  it("avoids infinite loops on cyclic objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(probeWebglRenderModel(cycle, 4, 2)).toBeNull();
  });

  it("handles getter throwing without crashing", () => {
    const fakeAddon = {
      get poison() {
        throw new Error("denied");
      },
      good: { cells: new Uint32Array(8) },
    };
    const probed = probeWebglRenderModel(fakeAddon, 1, 2);
    expect(probed).not.toBeNull();
    expect(probed!.cells.length).toBe(8);
  });
});

describe("diffModelAgainstBuffer", () => {
  function build(cols: number, rows: number, viewportY: number, codes: number[][]) {
    const term = fakeTerminal({ cols, rows, viewportY, codes: codes.slice() });
    const cells = makeModelCells(cols, rows, codes.slice(viewportY, viewportY + rows));
    const model: ProbedRenderModel = { cells, cols, rows, indicesPerCell: 4 };
    return { term, model };
  }

  it("reports zero mismatches when model and buffer agree", () => {
    const { term, model } = build(3, 2, 0, [
      [0x48, 0x69, 0x21],
      [0, 0, 0],
    ]);
    const report = diffModelAgainstBuffer(term, model);
    expect(report.mismatchCount).toBe(0);
    expect(report.matchCount).toBe(6);
    expect(report.mismatches).toEqual([]);
  });

  it("locates cells where model code differs from buffer code", () => {
    const cols = 3;
    const rows = 2;
    const term = fakeTerminal({
      cols,
      rows,
      viewportY: 0,
      codes: [
        [0x48, 0x69, 0x21], // H i !
        [0x4d, 0x4d, 0x4d], // M M M  -- buffer
      ],
    });
    const cells = makeModelCells(cols, rows, [
      [0x48, 0x69, 0x21],
      [0x4d, 0x5f, 0x4d], // 中间一个被 desync 成 "_"
    ]);
    const report = diffModelAgainstBuffer(term, { cells, cols, rows, indicesPerCell: 4 });
    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0]).toMatchObject({
      row: 1,
      col: 1,
      bufferChar: "M",
      modelChar: "_",
    });
    expect(report.mismatches[0].modelCellRaw).toMatch(/^0x0000005f,/);
  });

  it("compares against viewport-relative buffer rows when scrolled", () => {
    const cols = 2;
    const rows = 1;
    const term = fakeTerminal({
      cols,
      rows,
      viewportY: 5,
      codes: [
        ...Array.from({ length: 5 }, () => [0, 0]),
        [0x58, 0x59], // X Y at absolute row 5
      ],
    });
    const cells = makeModelCells(cols, rows, [[0x58, 0x59]]);
    const report = diffModelAgainstBuffer(term, { cells, cols, rows, indicesPerCell: 4 });
    expect(report.mismatchCount).toBe(0);
    expect(report.viewportY).toBe(5);
  });

  it("does not treat combined-char cells as mismatches when buffer codepoint differs", () => {
    // model 对 combined char 存 (COMBINED_CHAR_BIT | index), 不是 codepoint。
    // 直接和 buffer.getCode() 比会假阳性——这里验证 skippedCombined 路径。
    const cols = 2;
    const rows = 1;
    const COMBINED_BIT = 0x80000000;
    const term = fakeTerminal({
      cols,
      rows,
      viewportY: 0,
      codes: [[0x4e2d, 0x6587]], // 中, 文
    });
    const cells = new Uint32Array(cols * rows * 4);
    cells[0] = (COMBINED_BIT | 0x12) >>> 0; // combined idx 0x12, NOT codepoint 0x4e2d
    cells[4] = (COMBINED_BIT | 0x34) >>> 0;
    const report = diffModelAgainstBuffer(term, { cells, cols, rows, indicesPerCell: 4 });
    expect(report.mismatchCount).toBe(0);
    expect(report.matchCount).toBe(0);
    expect(report.skippedCombined).toBe(2);
  });

  it("clearRenderModel zeroes cells and lineLengths so next diff sees full mismatch", () => {
    const cols = 2;
    const rows = 1;
    const cells = makeModelCells(cols, rows, [[0x41, 0x42]]);
    const lineLengths = new Uint32Array([2]);
    const model: ProbedRenderModel = {
      cells,
      lineLengths,
      cols,
      rows,
      indicesPerCell: 4,
    };
    clearRenderModel(model);
    expect(Array.from(cells)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(lineLengths)).toEqual([0]);
  });

  it("clearRenderModel works without lineLengths", () => {
    const cells = new Uint32Array([0x41, 0, 0, 0]);
    const model: ProbedRenderModel = { cells, cols: 1, rows: 1, indicesPerCell: 4 };
    expect(() => clearRenderModel(model)).not.toThrow();
    expect(cells[0]).toBe(0);
  });

  it("caps mismatch list and flags truncated", () => {
    const cols = 100;
    const rows = 5;
    const bufferCodes = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => 0x41),
    );
    const modelCodes = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0x42));
    const term = fakeTerminal({ cols, rows, viewportY: 0, codes: bufferCodes });
    const cells = makeModelCells(cols, rows, modelCodes);
    const report = diffModelAgainstBuffer(term, { cells, cols, rows, indicesPerCell: 4 });
    expect(report.mismatchCount).toBe(500);
    expect(report.mismatches.length).toBeLessThanOrEqual(200);
    expect(report.truncated).toBe(true);
  });
});
