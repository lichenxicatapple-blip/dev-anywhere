import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayAutoUpdater } from "#src/auto-update.js";
import type { ServiceCommandResult } from "#src/common/service-command-result.js";
import { terminateOwnedProcessTree } from "#src/common/process-termination.js";
import {
  compareStableVersions,
  parseStableVersion,
  selectHighestStableVersion,
} from "#src/common/stable-version.js";
import {
  acquireUpdateLock,
  installVersion,
  planRelayDirectedUpdate,
  restartWithRecovery,
  runProxyServiceCommand,
  runRelayDirectedUpdate,
  type RelayDirectedUpdateDeps,
  type RestartRecoveryDeps,
  type RunnerOptions,
} from "#src/update-runner.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

vi.mock("#src/common/process-termination.js", () => ({
  terminateOwnedProcessTree: vi.fn(() => true),
}));

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function fakeChild(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  vi.mocked(terminateOwnedProcessTree).mockClear();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("stable Proxy versions", () => {
  it("accepts only exact stable three-part versions", () => {
    expect(parseStableVersion("0.6.4")).toEqual({ major: 0, minor: 6, patch: 4 });
    expect(parseStableVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseStableVersion("v0.6.4")).toBeNull();
    expect(parseStableVersion("0.6.4-beta.1")).toBeNull();
    expect(parseStableVersion("latest")).toBeNull();
    expect(parseStableVersion("0.6.4 --ignore-scripts")).toBeNull();
  });

  it("compares numeric version components", () => {
    expect(compareStableVersions("0.6.10", "0.6.9")).toBe(1);
    expect(compareStableVersions("0.6.3", "0.6.3")).toBe(0);
    expect(compareStableVersions("0.6.3", "0.7.0")).toBe(-1);
    expect(compareStableVersions("invalid", "0.7.0")).toBeNull();
  });

  it("retains only the highest valid stable version", () => {
    expect(selectHighestStableVersion(null, "invalid")).toBeNull();
    expect(selectHighestStableVersion(null, "0.9.2")).toBe("0.9.2");
    expect(selectHighestStableVersion("0.9.2", "0.9.1")).toBe("0.9.2");
    expect(selectHighestStableVersion("0.9.2", "0.9.3")).toBe("0.9.3");
  });
});

describe("Relay-directed update planning", () => {
  it("installs only the exact newer Relay version", () => {
    expect(
      planRelayDirectedUpdate({
        runningVersion: "0.6.3",
        installedVersion: "0.6.3",
        targetVersion: "0.6.4",
      }),
    ).toEqual({ kind: "install-and-restart", version: "0.6.4" });
  });

  it("restarts an old profile after another profile already installed the target", () => {
    expect(
      planRelayDirectedUpdate({
        runningVersion: "0.6.3",
        installedVersion: "0.6.4",
        targetVersion: "0.6.4",
      }),
    ).toEqual({ kind: "restart", version: "0.6.4" });
  });

  it("never downgrades or follows a Relay older than the running daemon", () => {
    expect(
      planRelayDirectedUpdate({
        runningVersion: "0.6.4",
        installedVersion: "0.6.4",
        targetVersion: "0.6.3",
      }),
    ).toEqual({ kind: "none", reason: "already-current" });
    expect(
      planRelayDirectedUpdate({
        runningVersion: "0.6.2",
        installedVersion: "0.7.0",
        targetVersion: "0.6.4",
      }),
    ).toEqual({ kind: "none", reason: "installed-ahead-of-relay" });
  });
});

describe("Relay-directed update execution", () => {
  const options: RunnerOptions = {
    targetVersion: "0.7.0",
    runningVersion: "0.6.3",
    relayName: "cloud",
  };

  function runtime(installedVersion = "0.6.3") {
    const release = vi.fn();
    const deps: RelayDirectedUpdateDeps = {
      acquireLock: vi.fn(() => ({ release })),
      resolveNpm: vi.fn(() => "/node/bin/npm"),
      verifyNpm: vi.fn(async () => undefined),
      readInstalledVersion: vi.fn(() => installedVersion),
      installVersion: vi.fn(async () => undefined),
      validateInstalledCli: vi.fn(async () => undefined),
      restartWithRecovery: vi.fn(async () => undefined),
    };
    return { deps, release };
  }

  it("installs, validates, and only then restarts", async () => {
    const { deps, release } = runtime();
    const order: string[] = [];
    vi.mocked(deps.installVersion).mockImplementation(async () => {
      order.push("install");
    });
    vi.mocked(deps.validateInstalledCli).mockImplementation(async () => {
      order.push("validate");
    });
    vi.mocked(deps.restartWithRecovery).mockImplementation(async () => {
      order.push("restart");
    });

    await expect(runRelayDirectedUpdate(options, deps)).resolves.toBe(0);
    expect(order).toEqual(["install", "validate", "restart"]);
    expect(deps.installVersion).toHaveBeenCalledWith("/node/bin/npm", "0.7.0");
    expect(deps.restartWithRecovery).toHaveBeenCalledWith(options, "/node/bin/npm", "0.6.3", true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps an intact previous package and leaves restart untouched when installation fails", async () => {
    const { deps, release } = runtime();
    vi.mocked(deps.installVersion).mockRejectedValueOnce(new Error("registry unavailable"));

    await expect(runRelayDirectedUpdate(options, deps)).rejects.toThrow(
      "previous package 0.6.3 remains intact",
    );
    expect(deps.installVersion).toHaveBeenNthCalledWith(1, "/node/bin/npm", "0.7.0");
    expect(deps.validateInstalledCli).toHaveBeenCalledWith("0.6.3");
    expect(deps.restartWithRecovery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back a package that installs but fails CLI validation", async () => {
    const { deps } = runtime();
    vi.mocked(deps.readInstalledVersion).mockReturnValueOnce("0.6.3").mockReturnValueOnce("0.7.0");
    vi.mocked(deps.validateInstalledCli)
      .mockRejectedValueOnce(new Error("new CLI cannot load"))
      .mockResolvedValueOnce(undefined);

    await expect(runRelayDirectedUpdate(options, deps)).rejects.toThrow("restored 0.6.3");
    expect(deps.installVersion).toHaveBeenNthCalledWith(1, "/node/bin/npm", "0.7.0");
    expect(deps.installVersion).toHaveBeenNthCalledWith(2, "/node/bin/npm", "0.6.3");
    expect(deps.validateInstalledCli).toHaveBeenNthCalledWith(1, "0.7.0");
    expect(deps.validateInstalledCli).toHaveBeenNthCalledWith(2, "0.6.3");
    expect(deps.restartWithRecovery).not.toHaveBeenCalled();
  });

  it("does not reinstall when another profile already installed the Relay version", async () => {
    const { deps } = runtime("0.7.0");

    await expect(runRelayDirectedUpdate(options, deps)).resolves.toBe(0);
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.validateInstalledCli).toHaveBeenCalledWith("0.7.0");
    expect(deps.restartWithRecovery).toHaveBeenCalledWith(options, "/node/bin/npm", "0.7.0", false);
  });

  it("returns a retryable code while another profile holds the machine lock", async () => {
    const { deps } = runtime();
    vi.mocked(deps.acquireLock).mockReturnValue(null);

    await expect(runRelayDirectedUpdate(options, deps)).resolves.toBe(75);
    expect(deps.resolveNpm).not.toHaveBeenCalled();
  });
});

describe("auto-update restart recovery", () => {
  const options: RunnerOptions = {
    targetVersion: "0.7.0",
    runningVersion: "0.6.3",
    relayName: "cloud",
  };
  const result = (body: ServiceCommandResult | null, code = body?.status === "ready" ? 0 : 1) => ({
    code,
    signal: null,
    stdout: body === null ? "invalid result" : JSON.stringify(body),
    stderr: code === 0 ? "" : "Error: daemon failed to start",
    timedOut: false,
  });
  const ready: ServiceCommandResult = {
    status: "ready",
    pid: 5678,
    instanceId: "new-service",
    version: options.targetVersion,
    missingSessionIds: [],
  };
  const failedStartup: ServiceCommandResult = {
    status: "failed",
    code: "START_FAILED",
    message: "Service child exited during startup",
    recoveryToken: "failed-restart-token",
  };

  it("does not tree-kill a timed-out service command and its retained sessions", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const pending = runProxyServiceCommand("restart", options);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(terminateOwnedProcessTree).not.toHaveBeenCalled();
    child.emit("close", 1, null);
    await expect(pending).resolves.toMatchObject({ timedOut: true });
  });

  it("cleans up the npm installer subtree after a timeout", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "win32" });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const pending = installVersion(String.raw`C:\Program Files\nodejs\npm.cmd`, "0.7.0");
    const failed = expect(pending).rejects.toThrow("timed out");
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toMatch(/cmd\.exe$/i);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      expect.stringContaining("npm.cmd"),
    ]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(terminateOwnedProcessTree).toHaveBeenCalledWith(child, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 1, null);
    await failed;
  });

  it.each(["restart", "start"] as const)(
    "passes conditional lifecycle arguments for update %s",
    async (action) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(child);
      const token = action === "start" ? "failed-restart-token" : undefined;

      const pending = runProxyServiceCommand(action, options, token);

      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
        expect.any(String),
        "--profile",
        expect.any(String),
        "serve",
        action,
        "--json",
        ...(action === "restart" ? ["--if-running"] : []),
        "--relay",
        "cloud",
        ...(token !== undefined ? ["--recover-from", token] : []),
      ]);
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({ code: 0, timedOut: false });
    },
  );

  function recoveryRuntime(): RestartRecoveryDeps {
    return {
      stopped: vi.fn(() => false),
      runService: vi.fn(async (action) => result(action === "start" ? ready : failedStartup)),
      installVersion: vi.fn(async () => undefined),
      validateInstalledCli: vi.fn(async () => undefined),
    };
  }

  it("does not restart a service the user stopped while npm was running", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.stopped).mockReturnValue(true);

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).resolves.toBeUndefined();
    expect(deps.runService).not.toHaveBeenCalled();
  });

  it("rolls the package back and starts the old daemon after a hard startup failure", async () => {
    const deps = recoveryRuntime();

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).rejects.toThrow("restored 0.6.3");
    expect(deps.installVersion).toHaveBeenCalledWith("/node/bin/npm", "0.6.3");
    expect(deps.validateInstalledCli).toHaveBeenCalledWith("0.6.3");
    expect(deps.runService).toHaveBeenNthCalledWith(1, "restart", options);
    expect(deps.runService).toHaveBeenNthCalledWith(2, "start", options, "failed-restart-token");
  });

  it("accepts confirmed readiness even when incomplete session handover returns nonzero", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService).mockResolvedValue(
      result({ ...ready, missingSessionIds: ["late-session"] }, 1),
    );

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).resolves.toBeUndefined();
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it.each(["STOP_FAILED", "UNSUPPORTED_SERVICE", "UNKNOWN_ERROR"])(
    "does not roll back or start a service after %s",
    async (code) => {
      const deps = recoveryRuntime();
      vi.mocked(deps.runService).mockResolvedValue(
        result({ status: "failed", code, message: "Service could not be restarted" }),
      );

      await expect(
        restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
      ).rejects.toThrow("Proxy auto-update restart");
      expect(deps.installVersion).not.toHaveBeenCalled();
      expect(deps.runService).toHaveBeenCalledOnce();
    },
  );

  it("does not infer success from a zero exit without a valid result", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService).mockResolvedValue(result(null, 0));

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).rejects.toThrow("Proxy auto-update restart");
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it("does not recover from a timed-out restart even if output includes a recovery token", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService).mockResolvedValue({ ...result(failedStartup), timedOut: true });

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).rejects.toThrow("timed out");
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it("requires a recovery token before rolling back a failed startup", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService).mockResolvedValue(
      result({ status: "failed", code: "START_FAILED", message: "Startup failed" }),
    );

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).rejects.toThrow("Proxy auto-update restart");
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it("does not reinstall or recover a package this run did not install", async () => {
    const deps = recoveryRuntime();

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", false, deps),
    ).rejects.toThrow("Proxy auto-update restart");
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it("honors a stop reported by the restart operation", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService).mockResolvedValue(
      result({ status: "failed", code: "STOPPED", message: "User stopped the service" }),
    );

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).resolves.toBeUndefined();
    expect(deps.installVersion).not.toHaveBeenCalled();
    expect(deps.runService).toHaveBeenCalledOnce();
  });

  it("does not bypass a later user stop when conditional recovery is refused", async () => {
    const deps = recoveryRuntime();
    vi.mocked(deps.runService)
      .mockResolvedValueOnce(result(failedStartup))
      .mockResolvedValueOnce(
        result({ status: "failed", code: "STOPPED", message: "Stop state changed" }),
      );

    await expect(
      restartWithRecovery(options, "/node/bin/npm", "0.6.3", true, deps),
    ).rejects.toThrow("service recovery was cancelled because the stop state changed");
    expect(deps.installVersion).toHaveBeenCalledWith("/node/bin/npm", "0.6.3");
    expect(deps.runService).toHaveBeenCalledTimes(2);
    expect(deps.runService).toHaveBeenLastCalledWith("start", options, "failed-restart-token");
  });
});

describe("Relay auto-update coordinator", () => {
  it("starts one runner for a newer Relay and retries a failed update", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const spawnRunner = vi.fn((_args: readonly string[]) => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const updater = createRelayAutoUpdater({
      enabled: true,
      packagedRuntime: true,
      profileName: "default",
      relayName: "cloud",
      runningVersion: "0.6.3",
      logger: fakeLogger(),
      spawnRunner,
      retryInitialMs: 100,
      retryMaxMs: 100,
    });

    updater.considerRelayVersion("0.6.4");
    updater.considerRelayVersion("0.6.4");
    expect(spawnRunner).toHaveBeenCalledTimes(1);
    expect(spawnRunner.mock.calls[0]?.[0]).toEqual([
      "--profile",
      "default",
      "--target-version",
      "0.6.4",
      "--running-version",
      "0.6.3",
      "--relay",
      "cloud",
    ]);

    children[0]!.emit("exit", 75, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnRunner).toHaveBeenCalledTimes(2);
    updater.dispose();
  });

  it("does nothing for disabled, source, Quick Tunnel, invalid, or older targets", () => {
    const spawnRunner = vi.fn((_args: readonly string[]) => fakeChild());
    for (const overrides of [
      { enabled: false, packagedRuntime: true, profileName: "default" },
      { enabled: true, packagedRuntime: false, profileName: "default" },
      { enabled: true, packagedRuntime: true, profileName: "quick-tunnel" },
    ]) {
      const updater = createRelayAutoUpdater({
        ...overrides,
        relayName: "cloud",
        runningVersion: "0.6.3",
        logger: fakeLogger(),
        spawnRunner,
      });
      updater.considerRelayVersion("0.6.4");
      updater.dispose();
    }

    const updater = createRelayAutoUpdater({
      enabled: true,
      packagedRuntime: true,
      profileName: "default",
      relayName: "cloud",
      runningVersion: "0.6.3",
      logger: fakeLogger(),
      spawnRunner,
    });
    updater.considerRelayVersion("latest");
    updater.considerRelayVersion("0.6.2");
    updater.dispose();
    expect(spawnRunner).not.toHaveBeenCalled();
  });

  it("does not retry installations that are not managed by npm", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnRunner = vi.fn((_args: readonly string[]) => child);
    const updater = createRelayAutoUpdater({
      enabled: true,
      packagedRuntime: true,
      profileName: "default",
      relayName: "cloud",
      runningVersion: "0.6.3",
      logger: fakeLogger(),
      spawnRunner,
      retryInitialMs: 100,
      retryMaxMs: 100,
    });

    updater.considerRelayVersion("0.7.0");
    child.emit("exit", 64, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnRunner).toHaveBeenCalledTimes(1);
    updater.dispose();
  });

  it("runs the newest Relay target after an older in-flight runner finishes", () => {
    const children: ChildProcess[] = [];
    const spawnRunner = vi.fn((_args: readonly string[]) => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const updater = createRelayAutoUpdater({
      enabled: true,
      packagedRuntime: true,
      profileName: "default",
      relayName: "cloud",
      runningVersion: "0.6.3",
      logger: fakeLogger(),
      spawnRunner,
    });

    updater.considerRelayVersion("0.6.4");
    updater.considerRelayVersion("0.7.0");
    children[0]!.emit("exit", 0, null);
    expect(spawnRunner).toHaveBeenCalledTimes(2);
    expect(spawnRunner.mock.calls[1]?.[0]).toContain("0.7.0");
    updater.dispose();
  });
});

describe("machine-wide update lock", () => {
  it("allows only one updater and releases only its own record", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-update-lock-"));
    const path = join(dir, "auto-update.lock");
    try {
      const first = acquireUpdateLock(path);
      expect(first).not.toBeNull();
      expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({ pid: process.pid });
      expect(acquireUpdateLock(path)).toBeNull();
      first!.release();
      const second = acquireUpdateLock(path);
      expect(second).not.toBeNull();
      second!.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
