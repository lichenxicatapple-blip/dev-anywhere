import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import escape from "cross-spawn/lib/util/escape.js";
import {
  defaultShell,
  findExecutableCandidates,
  normalizeProcessEnvironment,
} from "./executable.js";

export interface CommandLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: true;
  /** node-pty accepts an already escaped Windows command line as a string. */
  ptyArgs?: string;
}

/** Win32 argv quoting, not shell escaping. Use only with CreateProcess-style native execution. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) throw new TypeError("Command arguments cannot contain NUL");
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') result += "\\".repeat(backslashes * 2 + 1);
    else result += "\\".repeat(backslashes);
    result += char;
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function prepareCommandLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): CommandLaunch {
  const environment = normalizeProcessEnvironment(env, platform);
  if (platform !== "win32") return { command, args: [...args], env: environment };
  const resolved = findExecutableCandidates(command, environment, { platform, cwd })[0] ?? command;
  const batch = /\.(?:cmd|bat)$/i.test(resolved);
  const cmd = /^cmd(?:\.exe)?$/i.test(win32.basename(resolved));
  const directory = win32.resolve(cwd);
  if ((batch || cmd) && /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(directory)) {
    throw new Error(
      "Windows CMD 不支持将网络共享目录作为工作目录，请选择本地目录或已映射的盘符路径。",
    );
  }
  if (!batch) {
    return { command: resolved, args: [...args], env: environment };
  }
  if ([resolved, ...args].some((value) => /[\r\n\0]/.test(value))) {
    throw new TypeError(
      "Windows batch commands cannot accept line breaks or NUL in arguments; use a native executable",
    );
  }

  // Share cross-spawn's CMD escaping between pipe-based processes and ConPTY. Pinning the
  // dependency keeps this internal utility's contract explicit; never enable spawn's shell mode.
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [
    escape.command(win32.normalize(resolved)),
    ...args.map((arg) => escape.argument(arg, doubleEscape)),
  ].join(" ");
  const shellArgs = ["/d", "/s", "/v:off", "/c", `"${line}"`];
  return {
    command: defaultShell(environment, platform),
    args: shellArgs,
    env: environment,
    windowsVerbatimArguments: true,
    ptyArgs: shellArgs.join(" "),
  };
}

export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (options.shell) throw new TypeError("spawnCommand does not accept shell mode");
  const cwd = typeof options.cwd === "object" ? fileURLToPath(options.cwd) : options.cwd;
  const launch = prepareCommandLaunch(
    command,
    args,
    options.env ?? process.env,
    process.platform,
    cwd,
  );
  return spawn(launch.command, launch.args, {
    ...options,
    env: launch.env,
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
