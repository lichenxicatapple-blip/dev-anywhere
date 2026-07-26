import { spawnScript } from "../common/env.js";
import { serviceLogger } from "../common/logger.js";
import { PROFILE_NAME } from "../common/paths.js";

export interface TerminalWorkerStartOptions {
  sessionId: string;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
}

export function buildTerminalWorkerArgs(
  options: TerminalWorkerStartOptions,
  profileName = PROFILE_NAME,
): string[] {
  return [
    "--profile",
    profileName,
    options.sessionId,
    options.cwd,
    options.name,
    String(options.cols),
    String(options.rows),
  ];
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
      {
        sessionId: options.sessionId,
        pid: child.pid,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      },
      "Terminal worker spawned",
    );
    return child.pid;
  }
}
