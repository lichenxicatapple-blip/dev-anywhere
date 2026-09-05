import { existsSync, readFileSync } from "node:fs";
import { probeProcess, type ProcessProbeResult } from "./process-probe.js";
import { PersistedSessionRecordSchema } from "./persisted-session.js";
import {
  readSessionRuntimeIpcVersions,
  sessionRuntimeIpcVersionMatches,
  type SessionRuntimeIpcVersions,
} from "./session-runtime-ipc-version.js";

export function readLivePtySessionIds(
  sessionsPath: string,
  sessionRuntimeIpcVersionPath: string,
  expectedProtocolVersions: SessionRuntimeIpcVersions,
  probe: (pid: number) => ProcessProbeResult = probeProcess,
): string[] {
  if (
    !sessionRuntimeIpcVersionMatches(
      readSessionRuntimeIpcVersions(sessionRuntimeIpcVersionPath),
      expectedProtocolVersions,
      "terminal",
    )
  ) {
    return [];
  }
  if (!existsSync(sessionsPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionsPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const ids = new Set<string>();
  for (const item of parsed) {
    const result = PersistedSessionRecordSchema.safeParse(item);
    if (!result.success) continue;
    const session = result.data;
    if (session.mode !== "pty") continue;
    if (probe(session.pid).status !== "not-found") ids.add(session.id);
  }
  return [...ids];
}

export async function waitForSessionHandover(options: {
  expectedSessionIds: readonly string[];
  loadActiveSessionIds: (timeoutMs: number) => Promise<readonly string[] | null>;
  timeoutMs: number;
  pollMs?: number;
  statusProbeTimeoutMs?: number;
  wait?: (delayMs: number) => Promise<unknown>;
}): Promise<string[]> {
  const expected = [...new Set(options.expectedSessionIds)];
  if (expected.length === 0) return [];
  const pollMs = Math.max(1, options.pollMs ?? 250);
  const wait =
    options.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadlineAt = Date.now() + options.timeoutMs;
  let waitedMs = 0;
  let lastMissing = expected;

  while (true) {
    const remainingBeforeProbe = Math.min(deadlineAt - Date.now(), options.timeoutMs - waitedMs);
    if (remainingBeforeProbe <= 0) return lastMissing;
    const probeTimeoutMs = Math.max(
      1,
      Math.min(options.statusProbeTimeoutMs ?? 1_000, remainingBeforeProbe),
    );
    const active = await options.loadActiveSessionIds(probeTimeoutMs);
    if (active) {
      const activeSet = new Set(active);
      lastMissing = expected.filter((id) => !activeSet.has(id));
      if (lastMissing.length === 0) return [];
    }
    const remainingMs = Math.min(deadlineAt - Date.now(), options.timeoutMs - waitedMs);
    if (remainingMs <= 0) return lastMissing;
    const delayMs = Math.min(pollMs, remainingMs);
    await wait(delayMs);
    waitedMs += delayMs;
  }
}
