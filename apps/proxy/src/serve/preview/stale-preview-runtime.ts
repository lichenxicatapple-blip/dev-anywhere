import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { serviceLogger } from "../../common/logger.js";

const execFileAsync = promisify(execFile);
const STOP_TIMEOUT_MS = 5_000;
const RUNTIME_MARKER_NAME = "runtime.json";

interface RuntimeMarker {
  version: 1;
  pid: number;
  provider: "cloudflare" | "cpolar";
  processStartedAt?: string;
  executablePath?: string;
}

interface RuntimeIdentity {
  pid: number;
  provider: "cloudflare" | "cpolar";
  processStartedAt?: string;
  executablePath?: string;
}

interface CpolarRuntimeProcessIdentity {
  processStartedAt: string;
  executablePath: string;
}

function parsePid(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const pid = Number(normalized);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function validProcessStartedAt(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function validExecutablePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096 && isAbsolute(value);
}

function isCpolarExecutable(path: string): boolean {
  return /^cpolar(?:\.exe)?$/i.test(basename(path));
}

function sameExecutablePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

async function unixProcessStartedAt(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
      timeout: 2_000,
      maxBuffer: 8 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function darwinExecutablePath(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
      { timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    const path = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n/"))
      ?.slice(1);
    return path && isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}

async function linuxExecutablePath(pid: number): Promise<string | null> {
  try {
    return await realpath(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

async function windowsProcessIdentity(pid: number): Promise<CpolarRuntimeProcessIdentity | null> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -ne $p) {",
    "  $p | Select-Object ExecutablePath, CreationDate | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 3_000, maxBuffer: 16 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(result.stdout.trim()) as {
      ExecutablePath?: unknown;
      CreationDate?: unknown;
    };
    if (
      !validExecutablePath(parsed.ExecutablePath) ||
      !validProcessStartedAt(parsed.CreationDate) ||
      !isCpolarExecutable(parsed.ExecutablePath)
    ) {
      return null;
    }
    return {
      executablePath: parsed.ExecutablePath,
      processStartedAt: parsed.CreationDate,
    };
  } catch {
    return null;
  }
}

export async function captureCpolarRuntimeProcessIdentity(
  pid: number,
): Promise<CpolarRuntimeProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === "win32") return windowsProcessIdentity(pid);

  const [processStartedAt, executablePath] = await Promise.all([
    unixProcessStartedAt(pid),
    process.platform === "darwin" ? darwinExecutablePath(pid) : linuxExecutablePath(pid),
  ]);
  if (!processStartedAt || !executablePath || !isCpolarExecutable(executablePath)) return null;
  return { processStartedAt, executablePath };
}

async function readRuntimeIdentity(runtimeDir: string): Promise<RuntimeIdentity | null> {
  try {
    const marker = JSON.parse(await readFile(join(runtimeDir, RUNTIME_MARKER_NAME), "utf8")) as
      | RuntimeMarker
      | undefined;
    if (marker && Number.isSafeInteger(marker.pid) && marker.pid > 1) {
      if (marker.version === 1 && marker.provider === "cloudflare") {
        return { pid: marker.pid, provider: "cloudflare" };
      }
      if (
        marker.version === 1 &&
        marker.provider === "cpolar" &&
        validProcessStartedAt(marker.processStartedAt) &&
        validExecutablePath(marker.executablePath) &&
        isCpolarExecutable(marker.executablePath)
      ) {
        return {
          pid: marker.pid,
          provider: "cpolar",
          processStartedAt: marker.processStartedAt,
          executablePath: marker.executablePath,
        };
      }
    }
  } catch {
    // A crash between spawn and marker persistence may still leave cloudflared's own pidfile.
  }
  try {
    const pid = parsePid(await readFile(join(runtimeDir, "cloudflared.pid"), "utf8"));
    return pid === null ? null : { pid, provider: "cloudflare" };
  } catch {
    return null;
  }
}

async function processCommand(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const result = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function matchesRuntimeIdentity(
  command: string,
  runtimeDir: string,
  identity: RuntimeIdentity,
): Promise<boolean> {
  if (identity.provider === "cpolar") {
    if (!identity.processStartedAt || !identity.executablePath) return false;
    const observed = await captureCpolarRuntimeProcessIdentity(identity.pid);
    return (
      observed !== null &&
      observed.processStartedAt === identity.processStartedAt &&
      sameExecutablePath(observed.executablePath, identity.executablePath)
    );
  }
  const configPath = join(runtimeDir, "cloudflared.yml");
  const pidFilePath = join(runtimeDir, "cloudflared.pid");
  return (
    /(?:^|[/\\\s])cloudflared(?:\.exe)?(?:\s|$)/i.test(command) &&
    command.includes(configPath) &&
    command.includes(pidFilePath)
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}

async function stopVerifiedRuntime(
  identity: RuntimeIdentity,
  runtimeDir: string,
): Promise<boolean> {
  const command = await processCommand(identity.pid);
  if (identity.provider === "cloudflare" && !command) return !isAlive(identity.pid);
  if (!(await matchesRuntimeIdentity(command ?? "", runtimeDir, identity))) return false;

  try {
    process.kill(identity.pid, identity.provider === "cpolar" ? "SIGINT" : "SIGTERM");
  } catch {
    return !isAlive(identity.pid);
  }
  if (await waitForExit(identity.pid, STOP_TIMEOUT_MS)) return true;

  // Re-verify immediately before escalation so PID reuse can never target an unrelated process.
  const commandBeforeKill = await processCommand(identity.pid);
  if (
    (identity.provider === "cloudflare" && !commandBeforeKill) ||
    !(await matchesRuntimeIdentity(commandBeforeKill ?? "", runtimeDir, identity))
  ) {
    return !isAlive(identity.pid);
  }
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch {
    return !isAlive(identity.pid);
  }
  return waitForExit(identity.pid, 1_000);
}

/** Stops tunnel children orphaned by a crashed Proxy, but only after exact identity checks. */
export async function cleanupStalePreviewRuntimes(runtimeRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      const runtimeDir = join(runtimeRoot, entry.name);
      const identity = await readRuntimeIdentity(runtimeDir);
      if (identity === null || !isAlive(identity.pid)) {
        await rm(runtimeDir, { recursive: true, force: true });
        return;
      }

      const stopped = await stopVerifiedRuntime(identity, runtimeDir);
      if (stopped) {
        await rm(runtimeDir, { recursive: true, force: true });
        serviceLogger.info(
          { pid: identity.pid, tunnelProvider: identity.provider },
          "Stopped stale web preview tunnel process",
        );
      } else {
        serviceLogger.warn(
          { pid: identity.pid, runtimeDir, tunnelProvider: identity.provider },
          "Skipped stale web preview process because its identity could not be verified",
        );
      }
    }),
  );
}

export function serializePreviewRuntimeMarker(
  pid: number,
  options: { provider: "cloudflare" } | ({ provider: "cpolar" } & CpolarRuntimeProcessIdentity),
): string {
  const marker: RuntimeMarker = {
    version: 1,
    pid,
    provider: options.provider,
    ...(options.provider === "cpolar"
      ? {
          processStartedAt: options.processStartedAt,
          executablePath: options.executablePath,
        }
      : {}),
  };
  return `${JSON.stringify(marker)}\n`;
}
