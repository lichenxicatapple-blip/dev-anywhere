// xterm-addon-webgl 内部 RenderModel 探测 + 与 buffer 真实状态做 diff。
//
// 假设:webgl 错位现象不是 atlas 损坏(否则选中重绘也会坏),而是 webgl renderer
// 的 diff-only model 与 buffer 状态脱钩——某些 cell "以为没变"被跳过,留着上一帧
// 的渲染。要验证这条假设需要直接读 model.cells 和 buffer 对应位置的 cell,逐格比对。
//
// 跨版本稳定性:不依赖私有字段名(bundle minify 后名字会变),按 Uint32Array 形状
// 反向找——长度等于 cols*rows*4 的 Uint32Array 就是 model.cells。同一对象上
// 长度等于 rows 的 Uint32Array 视为 lineLengths(可选)。
import type { Terminal } from "@xterm/xterm";

export interface ProbedRenderModel {
  cells: Uint32Array;
  lineLengths?: Uint32Array;
  cols: number;
  rows: number;
  indicesPerCell: 4;
}

export function probeWebglRenderModel(
  root: object,
  cols: number,
  rows: number,
): ProbedRenderModel | null {
  const expectedCellsSize = cols * rows * 4;
  if (expectedCellsSize <= 0) return null;
  const visited = new WeakSet<object>();

  function inspect(obj: object): ProbedRenderModel | null {
    let cells: Uint32Array | null = null;
    let lineLengths: Uint32Array | null = null;
    for (const key of Object.getOwnPropertyNames(obj)) {
      let val: unknown;
      try {
        val = (obj as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (val instanceof Uint32Array) {
        if (val.length === expectedCellsSize) cells = val;
        else if (val.length === rows && !lineLengths) lineLengths = val;
      }
    }
    if (!cells) return null;
    return { cells, lineLengths: lineLengths ?? undefined, cols, rows, indicesPerCell: 4 };
  }

  function walk(obj: unknown, depth: number): ProbedRenderModel | null {
    if (!obj || typeof obj !== "object") return null;
    if (visited.has(obj as object)) return null;
    visited.add(obj as object);
    const direct = inspect(obj as object);
    if (direct) return direct;
    if (depth >= 5) return null;
    for (const key of Object.getOwnPropertyNames(obj as object)) {
      let val: unknown;
      try {
        val = (obj as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (val && typeof val === "object") {
        const found = walk(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(root, 0);
}

export interface RenderDiffMismatch {
  row: number;
  col: number;
  bufferCode: number;
  bufferChar: string;
  modelCode: number;
  modelChar: string;
  // 原始 cell 4 个 uint32 的十六进制,便于人肉解读 combined-char flag、color 等
  modelCellRaw: string;
}

export interface RenderDiffReport {
  cols: number;
  rows: number;
  viewportY: number;
  totalCells: number;
  matchCount: number;
  mismatchCount: number;
  mismatches: RenderDiffMismatch[];
  truncated: boolean;
}

const COMBINED_CHAR_BIT = 0x80000000;
const MISMATCH_CAP = 200;

// 把 model.cells 清零,让下一帧 diff 把所有 cell 视为"需要重绘"——配 terminal.refresh()
// 用,绕过 webgl renderer 的 diff-only 路径。诊断工具,出现错位时按一下:如果错位消失,
// model desync 假设确认。lineLengths 也置 0(可选,probe 探到才清),避免某些版本
// 用 lineLengths 卡迭代上限漏掉部分 cell。
export function clearRenderModel(model: ProbedRenderModel): void {
  model.cells.fill(0);
  if (model.lineLengths) model.lineLengths.fill(0);
}

function decodeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0) return "·";
  if ((code & COMBINED_CHAR_BIT) !== 0) return `(combined:0x${code.toString(16)})`;
  if (code > 0x10ffff) return `(invalid:0x${code.toString(16)})`;
  try {
    return String.fromCodePoint(code);
  } catch {
    return `(invalid:0x${code.toString(16)})`;
  }
}

export function diffModelAgainstBuffer(
  term: Terminal,
  model: ProbedRenderModel,
): RenderDiffReport {
  const { cells, cols, rows, indicesPerCell } = model;
  const buffer = term.buffer.active;
  const viewportY = buffer.viewportY;
  const mismatches: RenderDiffMismatch[] = [];
  let matchCount = 0;
  let mismatchCount = 0;
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(row + viewportY);
    for (let col = 0; col < cols; col++) {
      const cell = line?.getCell(col);
      const bufferCode = cell?.getCode() ?? 0;
      const offset = (row * cols + col) * indicesPerCell;
      const modelCellRaw0 = cells[offset] ?? 0;
      const modelCellRaw1 = cells[offset + 1] ?? 0;
      const modelCellRaw2 = cells[offset + 2] ?? 0;
      const modelCellRaw3 = cells[offset + 3] ?? 0;
      const modelCodePlain =
        (modelCellRaw0 & COMBINED_CHAR_BIT) !== 0 ? modelCellRaw0 : modelCellRaw0;
      // 平凡 match: 都是空 cell, 或 codepoint 一致
      const codeMatches =
        bufferCode === modelCodePlain || (bufferCode === 0 && modelCodePlain === 0);
      if (codeMatches) {
        matchCount++;
        continue;
      }
      mismatchCount++;
      if (mismatches.length < MISMATCH_CAP) {
        mismatches.push({
          row,
          col,
          bufferCode,
          bufferChar: decodeChar(bufferCode),
          modelCode: modelCodePlain,
          modelChar: decodeChar(modelCodePlain),
          modelCellRaw: [modelCellRaw0, modelCellRaw1, modelCellRaw2, modelCellRaw3]
            .map((n) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`)
            .join(","),
        });
      }
    }
  }
  return {
    cols,
    rows,
    viewportY,
    totalCells: cols * rows,
    matchCount,
    mismatchCount,
    mismatches,
    truncated: mismatchCount > mismatches.length,
  };
}
