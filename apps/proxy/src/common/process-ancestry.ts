import { spawnSync } from "node:child_process";
import { readWindowsProcess } from "./windows-process.js";

const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const MAX_ANCESTRY_DEPTH = 64;

export type ParentProcessLookup = (pid: number) => number | null;

export function readParentProcessId(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (process.platform === "win32") {
    const parentPid = readWindowsProcess(pid)?.parentPid;
    return parentPid !== undefined && parentPid > 0 ? parentPid : null;
  }

  const commands = ["/bin/ps", "/usr/bin/ps", "ps"];
  const tried = new Set<string>();
  for (const command of commands) {
    if (tried.has(command)) continue;
    tried.add(command);
    const result = spawnSync(command, ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    return result.error || result.status !== 0 ? null : parseParentPid(result.stdout);
  }
  return null;
}

/**
 * Returns the closest candidate PID that contains `processPid` in its process subtree.
 * The writer PID itself counts as distance zero. A bounded walk and cycle guard make a
 * corrupted or racing process table fail closed instead of hanging the relay handler.
 */
export function findClosestAncestorPid(
  processPid: number,
  candidatePids: readonly number[],
  lookupParent: ParentProcessLookup = readParentProcessId,
): number | null {
  if (!Number.isSafeInteger(processPid) || processPid <= 0) return null;
  const candidates = new Set(candidatePids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  if (candidates.size === 0) return null;

  const visited = new Set<number>();
  let current = processPid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (candidates.has(current)) return current;
    if (visited.has(current)) return null;
    visited.add(current);

    const parent = lookupParent(current);
    if (parent === null || parent <= 0 || parent === current) return null;
    current = parent;
  }
  return null;
}

export function parseParentPid(output: string | Buffer | null | undefined): number | null {
  const match = String(output ?? "").match(/\d+/);
  if (!match) return null;
  const pid = Number(match[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
