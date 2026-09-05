import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { extractAgentInvocation, normalizeCliArgs, stripProxyProfileArgs } from "../cli-args.js";
import { parseTerminalWorkerCliArgs } from "../terminal-worker-args.js";
import type { ProviderId } from "../providers/types.js";
import { parseWindowsCommandLine, readWindowsProcess } from "./windows-process.js";

export interface ManagedSessionProcessIdentity {
  id: string;
  kind?: "agent" | "terminal";
  mode: "pty" | "json";
  provider?: ProviderId;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  workerSocketPath?: string;
}

function findEntryIndex(argv: readonly string[], name: string): number {
  return argv.findIndex((arg) => {
    const file = basename(arg.replaceAll("\\", "/"));
    return file === name || file === `${name}.js` || file === `${name}.ts`;
  });
}

function canonicalEntryPath(path: string): string | null {
  try {
    const resolved = realpathSync(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

function isDevAnywhereCliEntry(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const entry = canonicalEntryPath(path);
  if (entry === null) return false;
  // Identify the entry's own package, not this daemon's installation path. A live terminal can
  // belong to another checkout or a package-manager store retained across an update.
  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(join(directory, "package.json"), "r");
      const buffer = Buffer.alloc(65_537);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > 65_536) return false;
      const manifest = JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as {
        name?: unknown;
        bin?: { "dev-anywhere"?: unknown };
      } | null;
      if (manifest?.name !== "@dev-anywhere/proxy") return false;
      const bin = manifest.bin?.["dev-anywhere"];
      if (typeof bin !== "string") return false;
      return (
        entry === canonicalEntryPath(resolve(directory, bin)) ||
        entry === canonicalEntryPath(join(directory, "src", "index.ts"))
      );
    } catch (error) {
      if (fd !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

function readOption(args: readonly string[], name: string): string | null {
  const indexes = args.flatMap((arg, index) => (arg === name ? [index] : []));
  if (indexes.length !== 1) return null;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : null;
}

export function processArgvMatchesManagedSession(
  argv: readonly string[],
  identity: ManagedSessionProcessIdentity,
): boolean {
  if (identity.mode === "json") {
    const entryIndex = findEntryIndex(argv, "session-worker");
    if (entryIndex < 0 || identity.workerSocketPath === undefined || !identity.provider)
      return false;
    const workerArgs = argv.slice(entryIndex + 1);
    if (workerArgs[0] !== identity.id || workerArgs[1] !== identity.workerSocketPath) return false;
    const separatorIndex = workerArgs.indexOf("--");
    const controlArgs = workerArgs.slice(2, separatorIndex < 0 ? undefined : separatorIndex);
    return readOption(controlArgs, "--provider") === identity.provider;
  }

  if (identity.ptyOwner === "proxy-hosted") {
    const terminalWorkerIndex = findEntryIndex(argv, "terminal-worker");
    if (terminalWorkerIndex < 0) return false;
    const worker = parseTerminalWorkerCliArgs(argv.slice(terminalWorkerIndex + 1));
    return (
      worker !== null &&
      worker.sessionId === identity.id &&
      worker.kind === identity.kind &&
      worker.provider === identity.provider
    );
  }
  if (identity.ptyOwner !== "local-terminal") return false;

  // A terminal started from the local CLI learns its session id only after it is running, so the
  // id cannot be present in argv. Parse the actual DEV Anywhere invocation and require its command
  // to be the recorded provider; a provider name elsewhere in argv is not process identity.
  const entryIndex = argv.findIndex(isDevAnywhereCliEntry);
  if (entryIndex < 0 || identity.provider === undefined) return false;
  try {
    const invocation = extractAgentInvocation(
      stripProxyProfileArgs(normalizeCliArgs(argv.slice(entryIndex + 1))),
    );
    return invocation.provider === identity.provider;
  } catch {
    return false;
  }
}

function parsePosixCommandLine(command: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) return null;
  if (current) argv.push(current);
  return argv.length > 0 ? argv : null;
}

export function readProcessArgv(pid: number): string[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (process.platform === "win32") {
    const record = readWindowsProcess(pid);
    return record?.commandLine ? parseWindowsCommandLine(record.commandLine) : null;
  }

  if (process.platform === "linux") {
    try {
      const commandLine = readFileSync(`/proc/${pid}/cmdline`);
      const argv = commandLine.toString("utf-8").split("\0").filter(Boolean);
      if (argv.length > 0) return argv;
    } catch {
      // Fall through to ps for non-standard procfs setups.
    }
  }

  try {
    const command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePosixCommandLine(command);
  } catch {
    return null;
  }
}

export function isManagedSessionProcess(
  pid: number,
  identity: ManagedSessionProcessIdentity,
): boolean {
  const argv = readProcessArgv(pid);
  return argv !== null && processArgvMatchesManagedSession(argv, identity);
}
