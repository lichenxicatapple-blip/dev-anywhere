import {
  PTY_INITIAL_MAX_COLS,
  PTY_INITIAL_MAX_ROWS,
  PTY_INITIAL_MIN_COLS,
  PTY_INITIAL_MIN_ROWS,
} from "@dev-anywhere/shared";

interface TerminalWorkerCliArgs {
  sessionId: string;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
}

function parseDimension(value: string | undefined, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
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
  const cols = parseDimension(colsValue, PTY_INITIAL_MAX_COLS);
  const rows = parseDimension(rowsValue, PTY_INITIAL_MAX_ROWS);
  if (cols === null || rows === null) return null;
  return {
    sessionId,
    cwd,
    name,
    cols: Math.max(PTY_INITIAL_MIN_COLS, cols),
    rows: Math.max(PTY_INITIAL_MIN_ROWS, rows),
  };
}
