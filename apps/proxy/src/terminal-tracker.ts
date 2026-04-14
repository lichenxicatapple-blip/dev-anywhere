import pkg from "@xterm/headless";
const { Terminal } = pkg;
import type { IBufferCell } from "@xterm/headless";
import { createHash } from "node:crypto";
import type { TermSpan, TermLine } from "@cc-anywhere/shared";

export type { TermSpan, TermLine };

// ANSI 256 色调色板，索引 0-255 对应标准终端颜色
// 0-7: 标准色, 8-15: 亮色, 16-231: 6x6x6 RGB 立方, 232-255: 灰阶
const ANSI_256_COLORS: string[] = (() => {
  const colors: string[] = [];
  // 标准 8 色
  const base = [
    "#000000", "#aa0000", "#00aa00", "#aa5500",
    "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
  ];
  // 亮 8 色
  const bright = [
    "#555555", "#ff5555", "#55ff55", "#ffff55",
    "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
  ];
  colors.push(...base, ...bright);
  // 216 色 RGB 立方 (6x6x6)
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const hex =
          "#" +
          levels[r].toString(16).padStart(2, "0") +
          levels[g].toString(16).padStart(2, "0") +
          levels[b].toString(16).padStart(2, "0");
        colors.push(hex);
      }
    }
  }
  // 24 级灰阶
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    const hex = "#" + v.toString(16).padStart(2, "0").repeat(3);
    colors.push(hex);
  }
  return colors;
})();

// 从 IBufferCell 中提取前景或背景颜色的 hex 值
function cellColorToHex(cell: IBufferCell, isFg: boolean): string | undefined {
  const isDefault = isFg ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;

  const isRgb = isFg ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    const color = isFg ? cell.getFgColor() : cell.getBgColor();
    return "#" + color.toString(16).padStart(6, "0");
  }

  const isPalette = isFg ? cell.isFgPalette() : cell.isBgPalette();
  if (isPalette) {
    const idx = isFg ? cell.getFgColor() : cell.getBgColor();
    return ANSI_256_COLORS[idx] ?? undefined;
  }

  return undefined;
}

export class TerminalTracker {
  private readonly terminal: InstanceType<typeof Terminal>;
  private lastGridHash: string = "";
  private nextLineId: number;
  private anchorLineId: number | null = null;
  private clientRows: number | null = null;

  constructor(cols = 120, rows = 40) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.nextLineId = this.terminal.buffer.active.length;
    this.terminal.onLineFeed(() => {
      this.nextLineId++;
    });
    this.terminal.onTitleChange((title: string) => {
      this._title = title;
      this.onTitleChange?.(title);
    });
  }

  private _title = "";
  onTitleChange?: (title: string) => void;

  get title(): string {
    return this._title;
  }

  feed(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  // 从 xterm headless buffer 中提取当前 viewport 的文本网格（不含 scrollback）
  // 有 clientRows 时从底部提取 clientRows 行，否则提取全部 terminal.rows 行
  extractGrid(): TermLine[] {
    const buffer = this.terminal.buffer.active;
    const lines: TermLine[] = [];
    const baseY = buffer.baseY;
    const totalRows = this.terminal.rows;
    const extractRows = this.clientRows ?? totalRows;

    // 以光标行为锚点提取：光标放在提取区域的底部附近
    // 确保光标上方的内容（logo、输出）被包含
    const cursorAbsY = baseY + buffer.cursorY;
    // 光标在提取区域倒数第 3 行，留几行余量显示光标下方内容
    const bottomMargin = Math.min(3, extractRows - 1);
    let startY = cursorAbsY - (extractRows - 1 - bottomMargin);
    // 不超出 buffer 边界
    startY = Math.max(startY, baseY);
    startY = Math.min(startY, baseY + totalRows - extractRows);

    for (let y = startY; y < baseY + totalRows; y++) {
      const bufferLine = buffer.getLine(y);
      if (!bufferLine) {
        lines.push([]);
        continue;
      }

      const spans: TermSpan[] = [];
      let currentSpan: TermSpan | null = null;

      for (let x = 0; x < bufferLine.length; x++) {
        const cell = bufferLine.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;

        const chars = cell.getChars() || " ";
        const fg = cellColorToHex(cell, true);
        const bg = cellColorToHex(cell, false);
        const bold = !!cell.isBold() || undefined;
        const dim = !!cell.isDim() || undefined;
        const italic = !!cell.isItalic() || undefined;
        const underline = (cell.isUnderline() !== 0) || undefined;
        const strikethrough = !!cell.isStrikethrough() || undefined;

        if (
          currentSpan &&
          currentSpan.fg === fg &&
          currentSpan.bg === bg &&
          currentSpan.bold === bold &&
          currentSpan.dim === dim &&
          currentSpan.italic === italic &&
          currentSpan.underline === underline &&
          currentSpan.strikethrough === strikethrough
        ) {
          currentSpan.text += chars;
        } else {
          if (currentSpan) spans.push(currentSpan);
          currentSpan = {
            text: chars,
            ...(fg && { fg }),
            ...(bg && { bg }),
            ...(bold && { bold }),
            ...(dim && { dim }),
            ...(italic && { italic }),
            ...(underline && { underline }),
            ...(strikethrough && { strikethrough }),
          };
        }
      }
      if (currentSpan) spans.push(currentSpan);
      lines.push(spans);
    }

    return this.trimEmptyLines(lines, startY);
  }

  // 裁剪首尾空行：移除开头和结尾连续的纯空行，保留中间内容
  // startY 是提取起始的绝对行号，用于计算光标在提取结果中的位置
  private trimEmptyLines(lines: TermLine[], startY: number): TermLine[] {
    const buffer = this.terminal.buffer.active;
    const cursorAbsY = buffer.baseY + buffer.cursorY;
    const cursorInExtracted = cursorAbsY - startY;

    const isNonEmpty = (i: number) => {
      if (i === cursorInExtracted) return true;
      const line = lines[i];
      return line.some(span => span.text.trim().length > 0);
    };

    // 找第一个非空行
    let start = 0;
    while (start < lines.length && !isNonEmpty(start)) start++;

    // 找最后一个非空行
    let end = lines.length - 1;
    while (end >= start && !isNonEmpty(end)) end--;

    if (start > end) return [];
    return lines.slice(start, end + 1);
  }

  // 获取光标相对于 viewport 的位置
  getCursor(): { x: number; y: number } {
    const buffer = this.terminal.buffer.active;
    return {
      x: buffer.cursorX,
      y: buffer.cursorY,
    };
  }

  // 检测终端网格内容是否自上次调用以来发生变化
  hasGridChanged(): boolean {
    const grid = this.extractGrid();
    const hash = createHash("md5").update(JSON.stringify(grid)).digest("hex");
    if (hash !== this.lastGridHash) {
      this.lastGridHash = hash;
      return true;
    }
    return false;
  }

  getOldestLineId(): number {
    return this.nextLineId - this.terminal.buffer.active.length;
  }

  getNewestLineId(): number {
    return this.nextLineId - 1;
  }

  // 从 buffer 中按 lineId 提取指定范围的行
  // 返回 { startLineId, lines }，startLineId 是实际返回数据的起始行
  // 当请求范围在 buffer 之前时，自动从 buffer 最早行开始返回
  extractLines(fromLineId: number, count: number): { startLineId: number; lines: TermLine[] } {
    const buf = this.terminal.buffer.active;
    const oldestId = this.getOldestLineId();
    const newestId = this.getNewestLineId();

    if (fromLineId > newestId) {
      return { startLineId: fromLineId, lines: [] };
    }

    const startId = Math.max(fromLineId, oldestId);
    const endId = Math.min(startId + count, newestId + 1);

    const lines: TermLine[] = [];
    for (let id = startId; id < endId; id++) {
      const bufIdx = id - oldestId;
      const line = buf.getLine(bufIdx);
      if (line) {
        lines.push(this.lineToSpans(line));
      }
    }
    return { startLineId: startId, lines };
  }

  // 将单行 buffer line 转换为 TermSpan 数组，复用 extractGrid 的 span 合并逻辑
  private lineToSpans(bufferLine: ReturnType<typeof this.terminal.buffer.active.getLine>): TermLine {
    if (!bufferLine) return [];

    const spans: TermSpan[] = [];
    let currentSpan: TermSpan | null = null;

    for (let x = 0; x < bufferLine.length; x++) {
      const cell = bufferLine.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;

      const chars = cell.getChars() || " ";
      const fg = cellColorToHex(cell, true);
      const bg = cellColorToHex(cell, false);
      const bold = !!cell.isBold() || undefined;
      const dim = !!cell.isDim() || undefined;
      const italic = !!cell.isItalic() || undefined;
      const underline = (cell.isUnderline() !== 0) || undefined;
      const strikethrough = !!cell.isStrikethrough() || undefined;

      if (
        currentSpan &&
        currentSpan.fg === fg &&
        currentSpan.bg === bg &&
        currentSpan.bold === bold &&
        currentSpan.dim === dim &&
        currentSpan.italic === italic &&
        currentSpan.underline === underline &&
        currentSpan.strikethrough === strikethrough
      ) {
        currentSpan.text += chars;
      } else {
        if (currentSpan) spans.push(currentSpan);
        currentSpan = {
          text: chars,
          ...(fg && { fg }),
          ...(bg && { bg }),
          ...(bold && { bold }),
          ...(dim && { dim }),
          ...(italic && { italic }),
          ...(underline && { underline }),
          ...(strikethrough && { strikethrough }),
        };
      }
    }
    if (currentSpan) spans.push(currentSpan);
    return spans;
  }

  scrollUp(delta: number, clientRows?: number): void {
    const rows = clientRows ?? this.terminal.rows;
    const newestId = this.getNewestLineId();
    const oldestId = this.getOldestLineId();

    if (this.anchorLineId === null) {
      // 从 live 进入锚定模式：当前 viewport 顶行减去 delta
      this.anchorLineId = newestId - rows + 1 - delta;
    } else {
      this.anchorLineId = this.anchorLineId - delta;
    }
    // 下限为 oldestLineId
    this.anchorLineId = Math.max(this.anchorLineId, oldestId);
  }

  scrollDown(delta: number, clientRows?: number): void {
    if (this.anchorLineId === null) return;

    this.anchorLineId = this.anchorLineId + delta;
    // 锚点 + rows 超过 newestLineId 时回到 live 模式
    const rows = clientRows ?? this.terminal.rows;
    if (this.anchorLineId + rows > this.getNewestLineId()) {
      this.anchorLineId = null;
    }
  }

  isAnchored(): boolean {
    return this.anchorLineId !== null;
  }

  getAnchorLineId(): number | null {
    return this.anchorLineId;
  }

  clearAnchor(): void {
    this.anchorLineId = null;
  }

  getTerminalRows(): number {
    return this.terminal.rows;
  }

  setClientRows(rows: number): void {
    this.clientRows = rows;
  }

  getClientRows(): number {
    return this.clientRows ?? this.terminal.rows;
  }

  // 按 anchorLineId 提取 viewport 栅格，未锚定时等同于 extractGrid（实时画面）
  extractGridAtOffset(): TermLine[] {
    if (this.anchorLineId === null) {
      return this.extractGrid();
    }

    const rows = this.clientRows ?? this.terminal.rows;
    const { lines } = this.extractLines(this.anchorLineId, rows);

    // 不足行数时用空行填充
    while (lines.length < rows) {
      lines.push([]);
    }
    return lines;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
