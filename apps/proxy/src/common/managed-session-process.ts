import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { extractAgentInvocation, normalizeCliArgs, stripProxyProfileArgs } from "../cli-args.js";
import type { ProviderId } from "../providers/types.js";

export interface ManagedSessionProcessIdentity {
  id: string;
  mode: "pty" | "json";
  provider?: ProviderId;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  workerSocketPath?: string;
}

function findEntryIndex(argv: readonly string[], name: string): number {
  return argv.findIndex((arg) => {
    const file = basename(arg);
    return file === name || file === `${name}.js` || file === `${name}.ts`;
  });
}

function findDevAnywhereEntryIndex(argv: readonly string[]): number {
  return argv.findIndex((arg) => {
    const file = basename(arg);
    if (file === "dev-anywhere") return true;
    if (file !== "index.js" && file !== "index.ts") return false;
    const pathSegments = arg.replaceAll("\\", "/").split("/");
    return pathSegments.includes("dev-anywhere") || pathSegments.includes("@dev-anywhere");
  });
}

function readOption(args: readonly string[], name: string): string | null {
  const indexes = args.flatMap((arg, index) => (arg === name ? [index] : []));
  if (indexes.length !== 1) return null;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : null;
}

function terminalWorkerSessionId(args: readonly string[]): string | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--profile") {
      if (!args[index + 1]) return null;
      index += 2;
      continue;
    }
    if (arg?.startsWith("--profile=")) {
      if (arg.length === "--profile=".length) return null;
      index += 1;
      continue;
    }
    if (arg === "--") {
      index += 1;
    }
    break;
  }

  const workerArgs = args.slice(index);
  if (workerArgs.length !== 5) return null;
  const [sessionId, cwd, name, cols, rows] = workerArgs;
  if (!sessionId || !cwd || !name) return null;
  if (!Number.isInteger(Number(cols)) || Number(cols) <= 0) return null;
  if (!Number.isInteger(Number(rows)) || Number(rows) <= 0) return null;
  return sessionId;
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

  if (identity.ptyOwner !== "local-terminal") return false;
  const terminalWorkerIndex = findEntryIndex(argv, "terminal-worker");
  if (terminalWorkerIndex >= 0) {
    return (
      identity.provider === "claude" &&
      terminalWorkerSessionId(argv.slice(terminalWorkerIndex + 1)) === identity.id
    );
  }

  // A terminal started from the local CLI learns its session id only after it is running, so the
  // id cannot be present in argv. Parse the actual DEV Anywhere invocation and require its command
  // to be the recorded provider; a provider name elsewhere in argv is not process identity.
  const entryIndex = findDevAnywhereEntryIndex(argv);
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
