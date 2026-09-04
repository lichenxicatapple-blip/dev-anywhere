import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface SessionRuntimeIpcVersions {
  terminal: number;
  worker: number;
}

function isProtocolVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readSessionRuntimeIpcVersions(path: string): SessionRuntimeIpcVersions | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as {
      terminal?: unknown;
      worker?: unknown;
    };
    if (Object.keys(record).some((key) => key !== "terminal" && key !== "worker")) return null;
    if (!isProtocolVersion(record.terminal) || !isProtocolVersion(record.worker)) return null;
    return { terminal: record.terminal, worker: record.worker };
  } catch {
    return null;
  }
}

export function sessionRuntimeIpcVersionsMatch(
  actual: SessionRuntimeIpcVersions | null,
  expected: SessionRuntimeIpcVersions,
): boolean {
  return actual?.terminal === expected.terminal && actual.worker === expected.worker;
}

export function writeSessionRuntimeIpcVersions(
  path: string,
  versions: SessionRuntimeIpcVersions,
): void {
  atomicWriteFileSync(path, `${JSON.stringify(versions)}\n`, { ensureDir: true });
}
