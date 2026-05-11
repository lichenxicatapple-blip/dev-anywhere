import type { Terminal } from "@xterm/xterm";

// xterm 在 options.fontSize 变化时自行触发 render service 重算 cell 尺寸并重绘。
// term.resize(cols, rows) 在 cols/rows 没变时（这里就是这种情况）BufferService /
// CoreService 都直接早返回——是死代码，移除。pty-resize-controller 的 ResizeObserver
// 会观察到 .xterm-screen 尺寸变化后算出新 cols/rows 再 resize，由 onRelayout 触发的
// 上层 relayout 则负责把 spacer/host 同步到新 cell 尺寸。
export function applyPtyFontSize(term: Terminal, next: number, onRelayout?: () => void): boolean {
  if (term.options.fontSize === next) return false;
  term.options.fontSize = next;
  requestAnimationFrame(() => onRelayout?.());
  return true;
}
