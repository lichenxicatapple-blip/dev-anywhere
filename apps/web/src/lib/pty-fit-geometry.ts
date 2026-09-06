import type { Terminal } from "@xterm/xterm";
import { PTY_INITIAL_MAX_COLS, PTY_INITIAL_MAX_ROWS } from "@dev-anywhere/shared";
import { measureXtermCellSize } from "./pty-xterm-metrics";

export function measurePtyFitGeometry(
  container: HTMLElement,
  host: HTMLElement,
  terminal: Terminal,
): { cols: number; rows: number } | null {
  const cell = measureXtermCellSize(host, terminal);
  if (!cell) return null;
  const style = getComputedStyle(container);
  const padding = (value: string): number => Number.parseFloat(value) || 0;
  const width = container.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight);
  const height = container.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom);
  if (
    ![width, height, cell.cellW, cell.cellH].every((value) => Number.isFinite(value) && value > 0)
  ) {
    return null;
  }
  // Manual fitting uses the current rendered cell size, including the user's font setting.
  // Unlike initial creation, it may deliberately make the terminal narrower than 80 columns.
  return {
    cols: Math.min(PTY_INITIAL_MAX_COLS, Math.max(2, Math.floor(width / cell.cellW))),
    rows: Math.min(PTY_INITIAL_MAX_ROWS, Math.max(1, Math.floor(height / cell.cellH))),
  };
}
