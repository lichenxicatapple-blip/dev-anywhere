import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryAcquireFileLock } from "#src/common/file-lock.js";
import {
  createServiceLifecycle,
  ServiceLifecycleError,
  type ServiceLifecycleOptions,
} from "#src/common/service-lifecycle.js";
import { startServiceControl, type ServiceStatus } from "#src/common/service-control.js";
import { localIpcEndpointPath } from "#src/common/paths.js";
import { tryConnectSocket } from "#src/common/socket-connect.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

class TestChild extends EventEmitter {
  pid = 999_999;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unref = vi.fn();
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  });

  asProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function context(spawn?: () => ChildProcess) {
  const root = mkdtempSync(join(tmpdir(), "da-lifecycle-"));
  roots.push(root);
  const options: ServiceLifecycleOptions = {
    profile: "test",
    controlPath: localIpcEndpointPath(join(root, "control.sock")),
    socketPath: localIpcEndpointPath(join(root, "terminal.sock")),
    runtimeLockPath: join(root, "runtime.lock"),
    operationLockPath: join(root, "operation.lock"),
    stoppedPath: join(root, "stopped"),
    spawn:
      spawn ??
      vi.fn(() => {
        throw new Error("unexpected spawn");
      }),
    startupTimeoutMs: 500,
    stopTimeoutMs: 300,
  };
  return { options, lifecycle: createServiceLifecycle(options) };
}

async function service(
  options: ServiceLifecycleOptions,
  instanceId = "running",
  releaseOnStop = true,
) {
  const runtime = tryAcquireFileLock(options.runtimeLockPath);
  expect(runtime).not.toBeNull();
  const status: ServiceStatus = {
    pid: process.pid,
    profile: options.profile,
    instanceId,
    version: "0.9.2",
    state: "ready",
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    control.close();
    runtime!.release();
  };
  const onStop = vi.fn(() => {
    if (releaseOnStop) close();
  });
  const control = await startServiceControl({
    socketPath: options.controlPath,
    getStatus: () => status,
    onStop,
  });
  cleanups.push(close);
  return { status, close, onStop, control };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service lifecycle", () => {
  it("reports an absent service without starting one", async () => {
    const { options, lifecycle } = context();
    await expect(lifecycle.status()).resolves.toBeNull();
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("reuses an admitted ready service without reading a PID file", async () => {
    const { options, lifecycle } = context();
    const running = await service(options);
    await expect(lifecycle.start("explicit")).resolves.toEqual({
      status: "ready",
      service: running.status,
    });
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("lets explicit start clear stopped state but prevents reconnect resurrection", async () => {
    const { options, lifecycle } = context();
    writeFileSync(options.stoppedPath, "user-stop");
    await expect(lifecycle.start("recover")).rejects.toMatchObject({ code: "STOPPED" });
    await service(options);
    await expect(lifecycle.start("explicit")).resolves.toMatchObject({ status: "ready" });
    expect(existsSync(options.stoppedPath)).toBe(false);
  });

  it("launches a candidate and waits for its runtime ownership and readiness", async () => {
    const child = new TestChild();
    const { options, lifecycle } = context();
    options.spawn = vi.fn(() => {
      void service(options);
      return child.asProcess();
    });
    await expect(lifecycle.start("explicit")).resolves.toMatchObject({ status: "ready" });
    expect(options.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("serializes competing startup callers", async () => {
    const child = new TestChild();
    const { options, lifecycle } = context();
    options.spawn = vi.fn(() => {
      void service(options);
      return child.asProcess();
    });
    const other = createServiceLifecycle(options);
    const results = await Promise.all([lifecycle.start("explicit"), other.start("explicit")]);
    expect(results.map((result) => result.service.instanceId)).toEqual(["running", "running"]);
    expect(options.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn while another runtime is starting", async () => {
    const { options, lifecycle } = context();
    const runtime = tryAcquireFileLock(options.runtimeLockPath)!;
    cleanups.push(() => runtime.release());
    options.startupTimeoutMs = 80;
    await expect(createServiceLifecycle(options).start("explicit")).rejects.toMatchObject({
      code: "STOP_FAILED",
    });
    expect(options.spawn).not.toHaveBeenCalled();
    await expect(lifecycle.status()).resolves.toBeNull();
  });

  it("rejects an unmanaged live terminal socket without deleting it", async () => {
    const { options, lifecycle } = context();
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(options.socketPath, resolve));
    cleanups.push(() => server.close());
    await expect(lifecycle.start("explicit")).rejects.toMatchObject({
      code: "UNSUPPORTED_SERVICE",
    });
    await expect(lifecycle.stop()).rejects.toMatchObject({ code: "UNSUPPORTED_SERVICE" });
    const connection = await tryConnectSocket(options.socketPath);
    expect(connection).not.toBeNull();
    connection?.destroy();
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("does not identify a service using another profile as its own", async () => {
    const { options, lifecycle } = context();
    await service({ ...options, profile: "another" });
    await expect(lifecycle.start("explicit")).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("stops through control and waits until runtime ownership ends", async () => {
    const { options, lifecycle } = context();
    const running = await service(options);
    await lifecycle.stop();
    expect(running.onStop).toHaveBeenCalledTimes(1);
    expect(existsSync(options.stoppedPath)).toBe(true);
    const runtime = tryAcquireFileLock(options.runtimeLockPath);
    expect(runtime).not.toBeNull();
    runtime!.release();
  });

  it("does not declare stopped when only the control socket closes", async () => {
    const { options } = context();
    options.stopTimeoutMs = 80;
    const running = await service(options, "running", false);
    running.onStop.mockImplementation(() => running.control.close());
    await expect(createServiceLifecycle(options).stop()).rejects.toMatchObject({
      code: "STOP_FAILED",
    });
  });

  it("does not spawn the replacement if stopping the current service fails", async () => {
    const { options } = context();
    options.stopTimeoutMs = 80;
    await service(options, "running", false);
    await expect(createServiceLifecycle(options).restart()).rejects.toMatchObject({
      code: "STOP_FAILED",
    });
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("restarts through the same stop/start sequence", async () => {
    const { options, lifecycle } = context();
    const running = await service(options, "old");
    options.spawn = vi.fn(() => {
      void service(options, "new");
      return new TestChild().asProcess();
    });
    await expect(lifecycle.restart()).resolves.toMatchObject({ service: { instanceId: "new" } });
    expect(running.onStop).toHaveBeenCalledOnce();
    expect(existsSync(options.stoppedPath)).toBe(false);
  });

  it("does not restart after an explicit stop completed while waiting for the operation lock", async () => {
    const { options, lifecycle } = context();
    const operation = tryAcquireFileLock(options.operationLockPath)!;
    cleanups.push(() => operation.release());
    const pendingRestart = lifecycle.restart("recover");
    writeFileSync(options.stoppedPath, "new-explicit-stop");
    operation.release();

    await expect(pendingRestart).rejects.toMatchObject({ code: "STOPPED" });
    expect(readFileSync(options.stoppedPath, "utf8")).toBe("new-explicit-stop");
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("terminates only its own failed startup child before reporting START_FAILED", async () => {
    const child = new TestChild();
    const { options } = context(() => child.asProcess());
    options.startupTimeoutMs = 50;
    await expect(createServiceLifecycle(options).start("explicit")).rejects.toMatchObject({
      code: "START_FAILED",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("captures a synchronous spawn failure without leaving the operation locked", async () => {
    const { options, lifecycle } = context(
      vi.fn(() => {
        throw new Error("spawn rejected");
      }),
    );
    await expect(lifecycle.start("explicit")).rejects.toMatchObject({ code: "START_FAILED" });
    const operation = tryAcquireFileLock(options.operationLockPath);
    expect(operation).not.toBeNull();
    operation!.release();
  });

  it("provides conditional recovery only for its own failed restart", async () => {
    const { options, lifecycle } = context(
      vi.fn(() => {
        throw new Error("bad package");
      }),
    );
    await service(options, "old");
    let failure: unknown;
    try {
      await lifecycle.restart();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceLifecycleError);
    const { recoveryToken } = failure as ServiceLifecycleError;
    expect(recoveryToken).toBeTruthy();
    expect(readFileSync(options.stoppedPath, "utf8")).toBe(recoveryToken);
    options.spawn = vi.fn(() => {
      void service(options, "restored");
      return new TestChild().asProcess();
    });
    await expect(lifecycle.start("recover", recoveryToken)).resolves.toMatchObject({
      service: { instanceId: "restored" },
    });
  });

  it("cancels package recovery if a newer explicit stop changed the marker", async () => {
    const { options, lifecycle } = context();
    writeFileSync(options.stoppedPath, "restart-failure");
    await lifecycle.stop();
    expect(readFileSync(options.stoppedPath, "utf8")).not.toBe("restart-failure");
    await expect(lifecycle.start("recover", "restart-failure")).rejects.toMatchObject({
      code: "STOPPED",
    });
    expect(options.spawn).not.toHaveBeenCalled();
  });

  it("uses the same ownership checks for foreground start", async () => {
    const { options, lifecycle } = context();
    const start = vi.fn(async () => {
      await service(options, "foreground");
    });
    await expect(lifecycle.startForeground(start)).resolves.toMatchObject({
      service: { instanceId: "foreground" },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(options.spawn).not.toHaveBeenCalled();
  });
});
