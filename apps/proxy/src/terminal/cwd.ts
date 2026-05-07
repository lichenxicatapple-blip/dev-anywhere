import { statSync } from "node:fs";

function isDirectory(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveTerminalCwd(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.DEV_ANYWHERE_CWD, env.INIT_CWD, env.PWD, process.cwd()];
  return candidates.find(isDirectory) ?? process.cwd();
}
