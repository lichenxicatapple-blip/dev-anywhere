import type { ChildProcess } from "node:child_process";

interface TunnelChildTerminationOptions {
  processName: string;
  gracefulSignal: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalAndWait(
  child: ChildProcess,
  processName: string,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
    const cleanup = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      child.off("exit", onExit);
    };
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exited);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const onExit = () => finish(true);

    child.once("exit", onExit);
    let accepted: boolean;
    try {
      accepted = child.kill(signal);
    } catch {
      if (hasExited(child)) finish(true);
      else fail(`${processName} process could not be signalled with ${signal}`);
      return;
    }

    if (settled) return;
    if (hasExited(child)) {
      finish(true);
      return;
    }
    if (!accepted) {
      fail(`${processName} process rejected ${signal}`);
      return;
    }

    timerRef.current = setTimeout(() => finish(false), timeoutMs);
    timerRef.current.unref?.();
  });
}

export async function terminateTunnelChild(
  child: ChildProcess | null,
  options: TunnelChildTerminationOptions,
): Promise<void> {
  if (!child || hasExited(child)) return;

  const gracefulExit = await signalAndWait(
    child,
    options.processName,
    options.gracefulSignal,
    options.gracefulTimeoutMs,
  );
  if (gracefulExit) return;

  const forcedExit = await signalAndWait(
    child,
    options.processName,
    "SIGKILL",
    options.forceTimeoutMs ?? 1_000,
  );
  if (!forcedExit) {
    throw new Error(`${options.processName} process did not exit after SIGKILL`);
  }
}
