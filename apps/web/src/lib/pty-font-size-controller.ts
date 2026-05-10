import type { Terminal } from "@xterm/xterm";

// xterm 在 options.fontSize 变化时会自行触发 render service 重新计算 cell 尺寸并重绘——
// 不需要显式 refresh。在 WebGL renderer 下 refresh(0, rows-1) 会强制 atlas 全量重建，
// 是字号调整时的明显卡顿来源。term.resize(cols, rows) 仍保留：fontSize 改变 cell 尺寸后
// pty-resize-controller 会通过 ResizeObserver 算出新 cols/rows 再次 resize，但中间这一步
// 让 xterm 立刻 reflow 一次，避免短暂错位。
export function applyPtyFontSize(term: Terminal, next: number, onRelayout?: () => void): boolean {
  if (term.options.fontSize === next) return false;
  term.options.fontSize = next;
  term.resize(term.cols, term.rows);
  requestAnimationFrame(() => onRelayout?.());
  return true;
}
