import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock, tryAcquireFileLock } from "./file-lock.js";
import { requestServiceControl, type ServiceStatus } from "./service-control.js";
import { tryConnectSocket } from "./socket-connect.js";

export type ServiceLifecycleErrorCode =
  | "STOP_FAILED"
  | "START_FAILED"
  | "STOPPED"
  | "UNSUPPORTED_SERVICE";

export class ServiceLifecycleError extends Error {
  recoveryToken?: string;

  constructor(
    readonly code: ServiceLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServiceLifecycleError";
  }
}

export interface ServiceLifecycleOptions {
  profile: string;
  controlPath: string;
  socketPath: string;
  runtimeLockPath: string;
  operationLockPath: string;
  stoppedPath: string;
  spawn(): ChildProcess;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface ServiceReadyResult {
  status: "ready";
  service: ServiceStatus;
}

export interface ServiceLifecycle {
  status(): Promise<ServiceStatus | null>;
  start(intent: "explicit" | "recover", expectedStoppedToken?: string): Promise<ServiceReadyResult>;
  startForeground(start: () => Promise<void>): Promise<ServiceReadyResult>;
  stop(): Promise<void>;
  restart(intent?: "explicit" | "recover"): Promise<ServiceReadyResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeIsFree(path: string): boolean {
  const lock = tryAcquireFileLock(path);
  if (!lock) return false;
  lock.release();
  return true;
}

async function socketIsOccupied(path: string, timeoutMs: number): Promise<boolean> {
  const socket = await tryConnectSocket(path, timeoutMs);
  socket?.destroy();
  return socket !== null;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnChild(child: ChildProcess): Promise<void> {
  if (!child.pid || childHasExited(child)) return;
  for (const [signal, timeoutMs] of [
    ["SIGTERM", 2_000],
    ["SIGKILL", 1_000],
  ] as const) {
    const exited = await new Promise<boolean>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: boolean) => {
        if (timer) clearTimeout(timer);
        child.off("exit", onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      child.once("exit", onExit);
      try {
        child.kill(signal);
      } catch (error) {
        child.off("exit", onExit);
        if (childHasExited(child)) resolve(true);
        else reject(error);
        return;
      }
      if (childHasExited(child)) finish(true);
      else timer = setTimeout(() => finish(false), timeoutMs);
    });
    if (exited) return;
  }
  throw new Error("The service child did not exit after termination");
}

export function createServiceLifecycle(options: ServiceLifecycleOptions): ServiceLifecycle {
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  for (const timeout of [startupTimeoutMs, stopTimeoutMs]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("Invalid service timeout");
  }
  if (options.runtimeLockPath === options.operationLockPath) {
    throw new TypeError("Service operation and runtime locks must be different");
  }

  const control = async (action: "status" | "stop", timeoutMs = 5_000) => {
    let status;
    try {
      status = await requestServiceControl(options.controlPath, action, timeoutMs);
    } catch (error) {
      throw new ServiceLifecycleError("STOP_FAILED", "Service control could not be verified", {
        cause: error,
      });
    }
    if (status && status.profile !== options.profile) {
      throw new ServiceLifecycleError("STOP_FAILED", "Service control belongs to another profile");
    }
    return status;
  };
  const budget = (deadline: number) => Math.max(1, Math.min(5_000, deadline - Date.now()));
  const pause = (deadline: number) => sleep(Math.max(1, Math.min(50, deadline - Date.now())));
  const markStopped = () => {
    mkdirSync(dirname(options.stoppedPath), { recursive: true });
    const token = randomUUID();
    writeFileSync(options.stoppedPath, token, { mode: 0o600 });
    return token;
  };
  const stoppedToken = () => {
    try {
      return readFileSync(options.stoppedPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const clearStopped = () => {
    try {
      unlinkSync(options.stoppedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const unsupported = () =>
    new ServiceLifecycleError(
      "UNSUPPORTED_SERVICE",
      "An existing service cannot be managed by this version. Stop it using the CLI that started it before retrying.",
    );

  const withOperation = async <T>(run: () => Promise<T>): Promise<T> => {
    let lock;
    try {
      lock = await acquireFileLock(options.operationLockPath, {
        timeoutMs: startupTimeoutMs + stopTimeoutMs,
      });
    } catch (error) {
      throw new ServiceLifecycleError("STOP_FAILED", "Another service operation is still active", {
        cause: error,
      });
    }
    try {
      return await run();
    } finally {
      lock.release();
    }
  };

  // The runtime lock protects this inspection. It is never transferred to a child: a candidate
  // must acquire its own runtime lock before opening sockets or starting any service work.
  const canStart = async (deadline: number): Promise<boolean> => {
    const runtime = tryAcquireFileLock(options.runtimeLockPath);
    if (!runtime) return false;
    try {
      if (await socketIsOccupied(options.socketPath, budget(deadline))) throw unsupported();
      if (await control("status", budget(deadline))) {
        throw new ServiceLifecycleError(
          "STOP_FAILED",
          "Service control is live without runtime ownership",
        );
      }
      return true;
    } finally {
      runtime.release();
    }
  };

  const startInternal = async (
    intent: "explicit" | "recover",
    expectedStoppedToken?: string,
    foreground?: () => Promise<void>,
  ): Promise<ServiceReadyResult> => {
    if (expectedStoppedToken !== undefined && stoppedToken() !== expectedStoppedToken) {
      throw new ServiceLifecycleError(
        "STOPPED",
        "The service stop state changed; recovery was cancelled",
      );
    }
    if (
      intent === "recover" &&
      existsSync(options.stoppedPath) &&
      expectedStoppedToken === undefined
    ) {
      throw new ServiceLifecycleError("STOPPED", "Service was explicitly stopped");
    }
    if (intent === "explicit" || expectedStoppedToken !== undefined) clearStopped();

    const deadline = Date.now() + startupTimeoutMs;
    let child: ChildProcess | undefined;
    let childFailure: Error | undefined;
    const onChildError = (error: Error) => {
      childFailure = error;
    };
    try {
      while (Date.now() < deadline) {
        const current = await control("status", budget(deadline));
        if (current?.state === "ready") {
          if (runtimeIsFree(options.runtimeLockPath)) {
            throw new ServiceLifecycleError(
              "STOP_FAILED",
              "Service control is live without runtime ownership",
            );
          }
          return { status: "ready", service: current };
        }
        if (childFailure) throw childFailure;
        if (child && childHasExited(child)) {
          throw new Error(
            `Service child exited during startup (code=${child.exitCode}, signal=${child.signalCode})`,
          );
        }
        if (!child && !current && (await canStart(deadline))) {
          if (foreground) {
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                foreground(),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Foreground service startup timed out")),
                    Math.max(1, deadline - Date.now()),
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            const service = await control("status", budget(deadline));
            if (service?.state !== "ready") throw new Error("Service did not publish readiness");
            if (runtimeIsFree(options.runtimeLockPath)) {
              throw new ServiceLifecycleError(
                "STOP_FAILED",
                "Foreground service did not retain runtime ownership",
              );
            }
            return { status: "ready", service };
          }
          child = options.spawn();
          child.once("error", onChildError);
        }
        await pause(deadline);
      }
      throw new Error(`Service did not become ready within ${startupTimeoutMs}ms`);
    } catch (error) {
      if (child) {
        try {
          await stopOwnChild(child);
        } catch (terminationError) {
          throw new ServiceLifecycleError("STOP_FAILED", "Could not confirm service child exit", {
            cause: terminationError,
          });
        }
      }
      if (error instanceof ServiceLifecycleError) throw error;
      try {
        if (!(await canStart(Date.now() + 1_000))) {
          throw new ServiceLifecycleError(
            "STOP_FAILED",
            "A service is still running but could not be managed",
            { cause: error },
          );
        }
      } catch (inspectionError) {
        if (inspectionError instanceof ServiceLifecycleError) throw inspectionError;
        throw new ServiceLifecycleError(
          "STOP_FAILED",
          "Could not verify the service state after startup failure",
          { cause: inspectionError },
        );
      }
      throw new ServiceLifecycleError(
        "START_FAILED",
        `Service failed to start: ${messageOf(error)}`,
        { cause: error },
      );
    } finally {
      child?.off("error", onChildError);
      child?.unref();
    }
  };

  const stopInternal = async (): Promise<void> => {
    markStopped();
    const deadline = Date.now() + stopTimeoutMs;
    let stopRequested = false;
    try {
      while (Date.now() < deadline) {
        if (!stopRequested) {
          const service = await control("stop", budget(deadline));
          stopRequested = service !== null;
        }
        const runtime = tryAcquireFileLock(options.runtimeLockPath);
        if (runtime) {
          try {
            if (await socketIsOccupied(options.socketPath, budget(deadline))) throw unsupported();
            if (await control("status", budget(deadline))) {
              throw new ServiceLifecycleError(
                "STOP_FAILED",
                "Service control is still live after runtime ownership ended",
              );
            }
            return;
          } finally {
            runtime.release();
          }
        }
        await pause(deadline);
      }
      throw new Error(`Service did not stop within ${stopTimeoutMs}ms`);
    } catch (error) {
      if (error instanceof ServiceLifecycleError) throw error;
      throw new ServiceLifecycleError(
        "STOP_FAILED",
        `Could not confirm service stop: ${messageOf(error)}`,
        { cause: error },
      );
    }
  };

  return {
    status: () => control("status"),
    start: (intent, expectedStoppedToken) =>
      withOperation(() => startInternal(intent, expectedStoppedToken)),
    startForeground: (start) => withOperation(() => startInternal("explicit", undefined, start)),
    stop: () => withOperation(stopInternal),
    restart: (intent = "explicit") =>
      withOperation(async () => {
        if (intent === "recover" && existsSync(options.stoppedPath)) {
          throw new ServiceLifecycleError("STOPPED", "Service was explicitly stopped");
        }
        await stopInternal();
        try {
          return await startInternal("explicit");
        } catch (error) {
          const token = markStopped();
          if (error instanceof ServiceLifecycleError && error.code === "START_FAILED") {
            error.recoveryToken = token;
          }
          throw error;
        }
      }),
  };
}
