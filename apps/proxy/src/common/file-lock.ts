import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";

export interface FileLock {
  release(): void;
}

/** The file stays in place: replacing its inode would allow two independent locks. */
export function tryAcquireFileLock(path: string): FileLock | null {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  let acquired: boolean;
  try {
    acquired = tryLock(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!acquired) {
    closeSync(fd);
    return null;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
    },
  };
}

export async function acquireFileLock(
  path: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<FileLock> {
  const { timeoutMs = 10_000, pollMs = 25 } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("File lock timeout must be a finite non-negative number");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new RangeError("File lock polling interval must be a finite positive number");
  }

  const deadline = performance.now() + timeoutMs;
  while (true) {
    const lock = tryAcquireFileLock(path);
    if (lock) return lock;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error(`Timed out waiting for file lock: ${path}`);
    await sleep(Math.min(pollMs, remainingMs));
  }
}
