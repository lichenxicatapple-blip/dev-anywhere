import { win32 } from "node:path";
import type { TerminalShell, TerminalShellOption } from "@dev-anywhere/shared";
import {
  defaultShell,
  environmentValue,
  findExecutableCandidates,
  isExecutableFile,
  type ExecutableLookupOptions,
} from "./executable.js";

export interface ResolvedTerminalShell {
  command: string;
  label?: string;
}

interface WindowsTerminalShell extends TerminalShellOption {
  command: string;
}

function windowsTerminalShells(
  env: NodeJS.ProcessEnv,
  options: ExecutableLookupOptions,
): WindowsTerminalShell[] {
  const probe = options.isExecutableFile ?? ((file) => isExecutableFile(file, "win32"));
  const systemRoot = environmentValue(env, "SystemRoot", "win32") || "C:\\Windows";
  const programFiles = environmentValue(env, "ProgramFiles", "win32");
  const powerShell7 =
    findExecutableCandidates("pwsh.exe", env, { ...options, platform: "win32" })[0] ??
    (programFiles
      ? [win32.join(programFiles, "PowerShell", "7", "pwsh.exe")].find(probe)
      : undefined);
  const windowsPowerShell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const commandPrompt = win32.join(systemRoot, "System32", "cmd.exe");
  const shells: WindowsTerminalShell[] = [];
  if (powerShell7) {
    shells.push({ id: "powershell", label: "PowerShell 7", command: powerShell7 });
  } else if (probe(windowsPowerShell)) {
    shells.push({ id: "powershell", label: "Windows PowerShell", command: windowsPowerShell });
  }
  if (probe(commandPrompt)) shells.push({ id: "cmd", label: "CMD", command: commandPrompt });
  return shells;
}

/** Only Windows advertises a choice; other platforms keep their configured login shell. */
export function listTerminalShells(
  env: NodeJS.ProcessEnv = process.env,
  options: ExecutableLookupOptions = {},
): TerminalShellOption[] | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  return windowsTerminalShells(env, options).map(({ id, label }) => ({ id, label }));
}

/** Interactive shells are separate from the CMD interpreter used to launch .cmd/.bat tools. */
export function resolveTerminalShell(
  shell?: TerminalShell,
  env: NodeJS.ProcessEnv = process.env,
  options: ExecutableLookupOptions = {},
): ResolvedTerminalShell {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    if (shell !== undefined) throw new Error("CMD 和 PowerShell 选项仅支持 Windows 开发机");
    return { command: defaultShell(env, platform) };
  }
  const available = windowsTerminalShells(env, options);
  const resolved = shell === undefined ? available[0] : available.find(({ id }) => id === shell);
  if (!resolved) {
    const label = shell === "powershell" ? "PowerShell" : shell === "cmd" ? "CMD" : "Shell";
    throw new Error(label + " 不可用，请检查开发机上的 Shell 安装后重试");
  }
  return { command: resolved.command, label: resolved.label };
}
