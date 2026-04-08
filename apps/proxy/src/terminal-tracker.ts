import pkg from "@xterm/headless";
const { Terminal } = pkg;
import type { IBufferCell } from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
const { SerializeAddon } = serializePkg;
import { EventStore, encodeSizePayload } from "./event-store.js";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SNAPSHOT_EVENT_THRESHOLD = 100;

// 终端文本 span，包含文本内容和可选样式属性
export interface TermSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

// 终端行由多个连续 span 组成
export type TermLine = TermSpan[];

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
  private readonly terminal: Terminal;
  private readonly serialize: SerializeAddon;
  private readonly store: EventStore;
  private readonly snapshotPath: string;
  private eventsSinceSnapshot: number = 0;
  private lastGridHash: string = "";

  constructor(store: EventStore, snapshotPath: string, cols = 120, rows = 40) {
    this.store = store;
    this.snapshotPath = snapshotPath;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.serialize = new SerializeAddon();
    this.terminal.loadAddon(this.serialize);
  }

  feed(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.eventsSinceSnapshot++;
        resolve();
      });
    });
  }

  shouldSnapshot(): boolean {
    return this.eventsSinceSnapshot >= SNAPSHOT_EVENT_THRESHOLD;
  }

  takeSnapshot(): void {
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const serialized = this.serialize.serialize({ scrollback: 0 });
    const content = Buffer.from(serialized, "utf-8");
    // payload 格式：[4 字节 cols+rows][序列化内容]
    const sizeHeader = encodeSizePayload(cols, rows);
    const payload = Buffer.concat([sizeHeader, content]);

    this.store.writeSnapshot(payload);
    writeFileSync(this.snapshotPath, payload);

    this.eventsSinceSnapshot = 0;
  }

  onStateChange(from: string, to: string): void {
    if (from === "working" && to === "idle") {
      this.takeSnapshot();
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  // 从 xterm headless buffer 中提取带样式的文本网格
  extractGrid(): TermLine[] {
    const buffer = this.terminal.buffer.active;
    const lines: TermLine[] = [];
    const totalRows = buffer.length;

    for (let y = 0; y < totalRows; y++) {
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

        if (
          currentSpan &&
          currentSpan.fg === fg &&
          currentSpan.bg === bg &&
          currentSpan.bold === bold
        ) {
          currentSpan.text += chars;
        } else {
          if (currentSpan) spans.push(currentSpan);
          currentSpan = {
            text: chars,
            ...(fg && { fg }),
            ...(bg && { bg }),
            ...(bold && { bold }),
          };
        }
      }
      if (currentSpan) spans.push(currentSpan);
      lines.push(spans);
    }

    // 裁剪尾部空行（全部为默认样式的空格）
    while (lines.length > 0) {
      const last = lines[lines.length - 1];
      const isEmpty =
        last.length === 0 ||
        (last.length === 1 &&
          !last[0].fg &&
          !last[0].bg &&
          !last[0].bold &&
          last[0].text.trim() === "");
      if (isEmpty) {
        lines.pop();
      } else {
        break;
      }
    }

    return lines;
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

  dispose(): void {
    this.terminal.dispose();
  }
}
