import { spawnScript } from "../common/env.js";
import { serviceLogger } from "../common/logger.js";
import { PROFILE_NAME } from "../common/paths.js";
import type { TerminalWorkerBootstrap, TerminalWorkerCliArgs } from "../terminal-worker-args.js";

export interface TerminalWorkerStartOptions extends Omit<TerminalWorkerBootstrap, "args"> {
  sessionId: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function buildTerminalWorkerArgs(
  options: TerminalWorkerCliArgs,
  profileName = PROFILE_NAME,
): string[] {
  return [
    "--profile",
    profileName,
    "--session",
    options.sessionId,
    "--kind",
    options.kind,
    "--provider",
    options.provider,
  ];
}

export class TerminalWorkerSpawner {
  start(options: TerminalWorkerStartOptions): { pid: number; abort: () => void } {
    const { sessionId, env, ...bootstrap } = options;
    const child = spawnScript("terminal-worker", buildTerminalWorkerArgs(options), {
      env: env ?? { ...process.env },
      stdio: ["pipe", "ignore", "ignore"],
      logger: serviceLogger,
    });
    if (!child.pid || !child.stdin) {
      child.kill();
      throw new Error("Terminal worker failed to expose a process id or bootstrap channel");
    }
    child.stdin.on("error", (error) => {
      serviceLogger.warn(
        { sessionId, error: error.message },
        "Terminal worker bootstrap channel failed",
      );
    });
    child.stdin.end(JSON.stringify(bootstrap));
    serviceLogger.info(
      {
        sessionId,
        pid: child.pid,
        kind: options.kind,
        provider: options.provider,
        cwd: options.cwd,
      },
      "Terminal worker spawned",
    );
    return {
      pid: child.pid,
      abort: () => {
        child.kill();
      },
    };
  }
}
