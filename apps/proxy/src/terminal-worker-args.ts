export interface TerminalWorkerCliArgs {
  sessionId: string;
  cwd: string;
  name: string;
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

  const [sessionId, cwd, name] = argv.slice(index);
  if (!sessionId || !cwd || !name) return null;
  return { sessionId, cwd, name };
}
