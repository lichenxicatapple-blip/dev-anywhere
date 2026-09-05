import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const CODEX_THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const LSOF_TIMEOUT_MS = 1_000;

export interface CodexActiveWriter {
  pid: number;
}

export function findCodexActiveWriter(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexActiveWriter | null {
  // This is optional owner discovery, not an idle check. On Windows the actual
  // Codex startup error still reports active-writer conflicts without lsof.
  if (process.platform === "win32") return null;
  if (!CODEX_THREAD_ID_RE.test(threadId)) return null;
  const configuredHome = env.CODEX_HOME?.trim();
  const codexHome =
    configuredHome && isAbsolute(configuredHome) ? configuredHome : join(homedir(), ".codex");
  const lockPath = join(codexHome, "thread-writer-locks", `${threadId}.lock`);
  if (!existsSync(lockPath)) return null;

  const commands = process.platform === "darwin" ? ["/usr/sbin/lsof", "lsof"] : ["lsof"];
  for (const command of commands) {
    const result = spawnSync(command, ["-t", lockPath], {
      encoding: "utf8",
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    const pid = parseFirstPid(result.stdout);
    if (pid !== null) return { pid };
    if (!result.error) break;
  }
  return null;
}

export function parseFirstPid(output: string | Buffer | null | undefined): number | null {
  const match = String(output ?? "").match(/(?:^|\s)(\d+)(?=\s|$)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
