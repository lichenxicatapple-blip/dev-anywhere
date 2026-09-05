import { environmentValue, findExecutableCandidates } from "../common/executable.js";

export { findExecutableCandidates } from "../common/executable.js";

export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  envVarName: "CLAUDE_BIN" | "CODEX_BIN" | "KIMI_BIN",
  errorMessage: string,
  cwd: string = process.cwd(),
): string {
  const custom = environmentValue(env, envVarName)?.trim();
  if (custom) {
    const explicitPath =
      process.platform === "win32" ? /[\\/:]/.test(custom) : custom.includes("/");
    if (process.platform === "win32" || explicitPath) {
      const resolved = findExecutableCandidates(custom, env, { cwd })[0];
      if (resolved) return resolved;
    }
    if (explicitPath) {
      throw new Error(`${envVarName} is not an executable file: ${custom}`);
    }
    return custom;
  }
  const [first] = findExecutableCandidates(name, env, { cwd });
  if (first) return first;
  throw new Error(errorMessage);
}
