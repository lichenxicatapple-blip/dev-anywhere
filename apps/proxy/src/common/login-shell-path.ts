import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { posix } from "node:path";

export const LOGIN_SHELL_PATH_TIMEOUT_MS = 5_000;
export const LOGIN_SHELL_PATH_OUTPUT_LIMIT_BYTES = 16 * 1024;

const PATH_FRAME_START = Buffer.from("\x1edev-anywhere-path\x1f");
const PATH_FRAME_END = Buffer.from("\x1edev-anywhere-path-end\x1f");
const PRINT_PATH_COMMAND =
  "printf '\\036dev-anywhere-path\\037%s\\036dev-anywhere-path-end\\037' \"$PATH\"";

export type LoginShellPathFailureReason =
  | "unsupported-platform"
  | "invalid-shell"
  | "spawn-failed"
  | "missing-output-pipe"
  | "timed-out"
  | "output-limit-exceeded"
  | "shell-exited"
  | "invalid-output"
  | "invalid-path";

export type LoginShellPathRefreshResult =
  | { source: "login-shell"; path: string }
  | {
      source: "fallback";
      path: string | undefined;
      reason: LoginShellPathFailureReason;
    };

export type LoginShellPathSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LoginShellPathRefreshOptions {
  /** Override the account shell. Tests can pass a fake executable here. */
  shell?: string;
  /** Environment inherited by the login shell and used as the fallback source. */
  env?: NodeJS.ProcessEnv;
  /** Tests can inject a fake platform without changing process.platform. */
  platform?: NodeJS.Platform;
  /** May shorten the timeout for tests, but cannot raise the production ceiling. */
  timeoutMs?: number;
  /** May lower the output limit for tests, but cannot raise the production ceiling. */
  maxOutputBytes?: number;
  spawn?: LoginShellPathSpawn;
  /** Tests can replace POSIX process-group termination without signalling real processes. */
  killProcessGroup?: (pid: number) => void;
}

function boundedPositiveInteger(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ceiling;
  return Math.max(1, Math.min(Math.floor(value), ceiling));
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validAbsolutePosixPath(path: string | undefined): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    posix.isAbsolute(path) &&
    !containsControlCharacter(path)
  );
}

function parsePathFrame(output: Buffer): string | null {
  const start = output.indexOf(PATH_FRAME_START);
  if (start < 0 || output.indexOf(PATH_FRAME_START, start + PATH_FRAME_START.length) >= 0) {
    return null;
  }

  const payloadStart = start + PATH_FRAME_START.length;
  const end = output.indexOf(PATH_FRAME_END, payloadStart);
  if (end < 0 || output.indexOf(PATH_FRAME_END, end + PATH_FRAME_END.length) >= 0) return null;

  const payload = output.subarray(payloadStart, end);
  const path = payload.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(payload)) return null;
  return path;
}

function validPosixPath(path: string): boolean {
  if (path.length === 0 || containsControlCharacter(path)) return false;
  const entries = path.split(":");
  return entries.every((entry) => entry.length > 0 && posix.isAbsolute(entry));
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

function defaultKillProcessGroup(pid: number): void {
  process.kill(-pid, "SIGKILL");
}

/**
 * Reads PATH from the user's interactive login shell.
 *
 * Only PATH is framed by the command and returned. Shell startup stdout/stderr is never logged or
 * exposed in the result. Every failure returns the inherited PATH plus a stable reason code so the
 * caller can restart safely without making environment refresh a hard dependency.
 */
export async function refreshLoginShellPath(
  options: LoginShellPathRefreshOptions = {},
): Promise<LoginShellPathRefreshResult> {
  const env = options.env ?? process.env;
  const fallbackPath = env.PATH;
  const failure = (reason: LoginShellPathFailureReason): LoginShellPathRefreshResult => ({
    source: "fallback",
    path: fallbackPath,
    reason,
  });

  if ((options.platform ?? process.platform) === "win32") {
    return failure("unsupported-platform");
  }

  const shell = options.shell ?? env.SHELL;
  if (!validAbsolutePosixPath(shell)) return failure("invalid-shell");

  const timeoutMs = boundedPositiveInteger(options.timeoutMs, LOGIN_SHELL_PATH_TIMEOUT_MS);
  const maxOutputBytes = boundedPositiveInteger(
    options.maxOutputBytes,
    LOGIN_SHELL_PATH_OUTPUT_LIMIT_BYTES,
  );

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.spawn ?? defaultSpawn)(shell, ["-l", "-i", "-c", PRINT_PATH_COMMAND], {
        cwd: validAbsolutePosixPath(env.HOME) ? env.HOME : undefined,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(failure("spawn-failed"));
      return;
    }

    const terminate = () => {
      if (Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
        try {
          (options.killProcessGroup ?? defaultKillProcessGroup)(child.pid!);
          return;
        } catch {
          // The shell may have exited between the timeout and the signal; direct kill is the fallback.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // A concurrently exited shell needs no further cleanup.
      }
    };

    const output = child.stdout;
    if (!output) {
      terminate();
      resolve(failure("missing-output-pipe"));
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (result: LoginShellPathRefreshResult, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.removeAllListeners("data");
      if (kill) {
        output.destroy();
        terminate();
      }
      chunks.length = 0;
      resolve(result);
    };

    const timer = setTimeout(() => finish(failure("timed-out"), true), timeoutMs);
    timer.unref?.();

    output.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        finish(failure("output-limit-exceeded"), true);
        return;
      }
      chunks.push(buffer);
    });

    child.once("error", () => finish(failure("spawn-failed")));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(failure("shell-exited"));
        return;
      }
      const path = parsePathFrame(Buffer.concat(chunks, outputBytes));
      if (path === null) {
        finish(failure("invalid-output"));
        return;
      }
      if (!validPosixPath(path)) {
        finish(failure("invalid-path"));
        return;
      }
      finish({ source: "login-shell", path });
    });
  });
}
