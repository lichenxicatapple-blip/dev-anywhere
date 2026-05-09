import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function findExecutableCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return unique(pathEntries.map((entry) => join(entry, name))).filter(isExecutableFile);
}

export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  envVarName: "CLAUDE_BIN" | "CODEX_BIN",
  errorMessage: string,
): string {
  const custom = env[envVarName]?.trim();
  if (custom) {
    if (custom.includes("/") && !isExecutableFile(custom)) {
      throw new Error(`${envVarName} is not an executable file: ${custom}`);
    }
    return custom;
  }
  const [first] = findExecutableCandidates(name, env);
  if (first) return first;
  throw new Error(errorMessage);
}
