import type { IBuffer, Terminal } from "@xterm/xterm";

// 从 .xterm-screen 实测一格的像素尺寸。host 必须是 xterm 渲染所在的子树，
// term.cols/rows 必须 > 0；否则返回 null（由调用方决定如何降级）。
export function measureXtermCellSize(
  host: HTMLElement,
  term: Terminal,
): { cellW: number; cellH: number } | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return null;
  return {
    cellW: screen.clientWidth / term.cols,
    cellH: screen.clientHeight / term.rows,
  };
}

// 从底行往上找第一行有可见内容的相对行号，全空返回 -1。
// 用于 hostPaddingTop 的"冷启动留白"判断：当前 viewport 几乎全空时把 padding 顶到底。
export function findCanvasLastNonEmptyRow(buffer: IBuffer, rows: number): number {
  for (let ry = rows - 1; ry >= 0; ry--) {
    const absY = buffer.viewportY + ry;
    if (absY < 0 || absY >= buffer.length) continue;
    const line = buffer.getLine(absY);
    if (line && line.translateToString(true).trimEnd().length > 0) return ry;
  }
  return -1;
}
