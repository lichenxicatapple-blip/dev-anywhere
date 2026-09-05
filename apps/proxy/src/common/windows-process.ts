import { spawnSync } from "node:child_process";

export interface WindowsProcess {
  pid: number;
  parentPid: number;
  commandLine: string | null;
}

/** A missing/inaccessible process is unknown, never evidence that a stored PID is ours. */
export function readWindowsProcess(pid: number): WindowsProcess | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`,
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const record: unknown = JSON.parse(result.stdout);
    if (typeof record !== "object" || record === null) return null;
    const { ProcessId, ParentProcessId, CommandLine } = record as Record<string, unknown>;
    if (
      ProcessId !== pid ||
      typeof ParentProcessId !== "number" ||
      !Number.isSafeInteger(ParentProcessId) ||
      ParentProcessId < 0 ||
      (CommandLine !== null && typeof CommandLine !== "string")
    ) {
      return null;
    }
    return { pid, parentPid: ParentProcessId, commandLine: CommandLine };
  } catch {
    return null;
  }
}

/** Decode the quote/backslash rules used for native Windows argv, not shell syntax. */
export function parseWindowsCommandLine(command: string): string[] | null {
  const argv: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (command[index] === " " || command[index] === "\t") index += 1;
    if (index >= command.length) break;
    let argument = "";
    let quoted = false;
    while (index < command.length) {
      if (!quoted && (command[index] === " " || command[index] === "\t")) break;
      let backslashes = 0;
      while (command[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (command[index] === '"') {
        argument += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          argument += '"';
        } else if (quoted && command[index + 1] === '"') {
          argument += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        index += 1;
      } else {
        argument += "\\".repeat(backslashes);
        if (index >= command.length) break;
        // Backslashes may have ended immediately before the next argument.
        if (!quoted && (command[index] === " " || command[index] === "\t")) break;
        argument += command[index];
        index += 1;
      }
    }
    if (quoted) return null;
    argv.push(argument);
  }
  return argv.length > 0 ? argv : null;
}
