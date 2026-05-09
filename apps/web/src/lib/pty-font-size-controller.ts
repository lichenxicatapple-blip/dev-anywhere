import type { Terminal } from "@xterm/xterm";

export function applyPtyFontSize(term: Terminal, next: number, onRelayout?: () => void): boolean {
  if (term.options.fontSize === next) return false;
  term.options.fontSize = next;
  term.resize(term.cols, term.rows);
  if (term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
  requestAnimationFrame(() => onRelayout?.());
  return true;
}
