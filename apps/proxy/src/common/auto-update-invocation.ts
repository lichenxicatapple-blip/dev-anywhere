import { lstatSync, readFileSync } from "node:fs";
import { AUTO_UPDATE_LOCK_PATH } from "./paths.js";

const AUTO_UPDATE_LOCK_MAX_BYTES = 4 * 1024;
const AUTO_UPDATE_LOCK_MAX_AGE_MS = 30 * 60_000;

interface AutoUpdateInvocationOptions {
  lockPath?: string;
  parentPid?: number;
  now?: number;
}

interface AutoUpdateLockRecord {
  pid?: unknown;
  createdAt?: unknown;
}

/**
 * Identifies the service CLI spawned directly by the Relay auto-update runner.
 *
 * The runner owns the machine-wide update lock until its service command exits, and the lock stores
 * that runner's PID. Matching it against this CLI's parent PID works during the first rolling update
 * to a version that supports PATH refresh, without relying on an environment marker from the old
 * package. Every malformed, stale, or unexpected state fails closed as a normal manual invocation.
 */
export function isDirectAutoUpdateInvocation(options: AutoUpdateInvocationOptions = {}): boolean {
  const lockPath = options.lockPath ?? AUTO_UPDATE_LOCK_PATH;
  const parentPid = options.parentPid ?? process.ppid;
  const now = options.now ?? Date.now();

  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return false;
  if (!Number.isSafeInteger(now) || now <= 0) return false;

  try {
    const stat = lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return false;
    if (stat.size > AUTO_UPDATE_LOCK_MAX_BYTES) return false;

    const record = JSON.parse(readFileSync(lockPath, "utf8")) as AutoUpdateLockRecord;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return false;
    if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) <= 0) return false;

    const ageMs = now - (record.createdAt as number);
    return ageMs >= 0 && ageMs <= AUTO_UPDATE_LOCK_MAX_AGE_MS && record.pid === parentPid;
  } catch {
    return false;
  }
}
