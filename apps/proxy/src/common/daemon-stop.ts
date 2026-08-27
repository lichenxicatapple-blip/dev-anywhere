import { setTimeout as sleep } from "node:timers/promises";
import { probeProcess, type ProcessProbeResult } from "./process-probe.js";

export type ProcessExitWaitResult = "exited" | "timed-out" | "unverifiable";

export async function waitForProcessExit(
  pid: number,
  options: {
    timeoutMs: number;
    pollMs?: number;
    probe?: (pid: number) => ProcessProbeResult;
    wait?: (delayMs: number) => Promise<unknown>;
  },
): Promise<ProcessExitWaitResult> {
  const pollMs = Math.max(1, options.pollMs ?? 100);
  const probe = options.probe ?? probeProcess;
  const wait = options.wait ?? ((delayMs: number) => sleep(delayMs));

  for (let elapsed = 0; elapsed <= options.timeoutMs; elapsed += pollMs) {
    const result = probe(pid);
    if (result.status === "not-found") return "exited";
    if (result.status === "permission-denied" || result.status === "unknown") {
      return "unverifiable";
    }
    if (elapsed >= options.timeoutMs) break;
    await wait(Math.min(pollMs, options.timeoutMs - elapsed));
  }
  return "timed-out";
}
