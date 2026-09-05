import { spawnSync, type ChildProcess } from "node:child_process";

/** Only for a directly owned command, never a daemon with independently retained sessions. */
export function terminateOwnedProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  if (process.platform !== "win32") return child.kill(signal);
  const pid = child.pid;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return false;
  }
  // Node's Windows SIGTERM/SIGKILL only terminate the root. Keep npm/Agent wrappers
  // and their descendants together without selecting unrelated processes by name.
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 5_000,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}
