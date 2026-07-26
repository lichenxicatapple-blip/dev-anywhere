import {
  PTY_INITIAL_MAX_COLS,
  PTY_INITIAL_MAX_ROWS,
  PTY_INITIAL_MIN_COLS,
  PTY_INITIAL_MIN_ROWS,
} from "@dev-anywhere/shared";

export interface TerminalWorkerCliArgs {
  sessionId: string;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
}

function parseDimension(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

export function parseTerminalWorkerCliArgs(argv: readonly string[]): TerminalWorkerCliArgs | null {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--profile") {
      index += 2;
      continue;
    }
    if (arg?.startsWith("--profile=")) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      index += 1;
      break;
    }
    break;
  }

  const [sessionId, cwd, name, colsValue, rowsValue] = argv.slice(index);
  if (!sessionId || !cwd || !name) return null;
  return {
    sessionId,
    cwd,
    name,
    cols: parseDimension(colsValue, PTY_INITIAL_MIN_COLS, PTY_INITIAL_MAX_COLS),
    rows: parseDimension(rowsValue, PTY_INITIAL_MIN_ROWS, PTY_INITIAL_MAX_ROWS),
  };
}
