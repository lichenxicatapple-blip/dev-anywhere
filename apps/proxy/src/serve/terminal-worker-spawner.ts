import { spawnScript } from "../common/env.js";
import { serviceLogger } from "../common/logger.js";
import { PROFILE_NAME } from "../common/paths.js";

export interface TerminalWorkerStartOptions {
  sessionId: string;
  cwd: string;
  name: string;
}

export function buildTerminalWorkerArgs(
  options: TerminalWorkerStartOptions,
  profileName = PROFILE_NAME,
): string[] {
  return ["--profile", profileName, options.sessionId, options.cwd, options.name];
}

export class TerminalWorkerSpawner {
  start(options: TerminalWorkerStartOptions): number {
    const child = spawnScript("terminal-worker", buildTerminalWorkerArgs(options), {
      env: { ...process.env },
      logger: serviceLogger,
    });
    if (!child.pid) {
      throw new Error("Terminal worker failed to expose a process id");
    }
    serviceLogger.info(
      { sessionId: options.sessionId, pid: child.pid, cwd: options.cwd },
      "Terminal worker spawned",
    );
    return child.pid;
  }
}
