import type { Terminal } from "@xterm/xterm";
import { PTY_INITIAL_MAX_COLS, PTY_INITIAL_MAX_ROWS } from "@dev-anywhere/shared";
import { measureXtermCellSize } from "./pty-xterm-metrics";

export const PTY_MIN_COLS = 2;
export const PTY_MIN_ROWS = 1;

export type PtyResizeAction =
  | "fit"
  | "increase-cols"
  | "decrease-cols"
  | "increase-rows"
  | "decrease-rows";

export interface PtyResizeRequest {
  requestId: string;
  action: PtyResizeAction;
}

export interface PtyGeometry {
  cols: number;
  rows: number;
}

export function adjustPtyGeometry(
  current: PtyGeometry,
  action: Exclude<PtyResizeAction, "fit">,
): PtyGeometry {
  return {
    cols:
      action === "increase-cols" && current.cols < PTY_INITIAL_MAX_COLS
        ? current.cols + 1
        : action === "decrease-cols" && current.cols > PTY_MIN_COLS
          ? current.cols - 1
          : current.cols,
    rows:
      action === "increase-rows" && current.rows < PTY_INITIAL_MAX_ROWS
        ? current.rows + 1
        : action === "decrease-rows" && current.rows > PTY_MIN_ROWS
          ? current.rows - 1
          : current.rows,
  };
}

export function measurePtyFitGeometry(
  container: HTMLElement,
  host: HTMLElement,
  terminal: Terminal,
): PtyGeometry | null {
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
    cols: Math.min(PTY_INITIAL_MAX_COLS, Math.max(PTY_MIN_COLS, Math.floor(width / cell.cellW))),
    rows: Math.min(PTY_INITIAL_MAX_ROWS, Math.max(PTY_MIN_ROWS, Math.floor(height / cell.cellH))),
  };
}
