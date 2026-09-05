import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import { IS_DEV, spawnScript } from "./common/env.js";
import { compareStableVersions } from "./common/stable-version.js";

const UPDATE_RETRY_INITIAL_MS = 15 * 60_000;
const UPDATE_RETRY_MAX_MS = 6 * 60 * 60_000;
const QUICK_TUNNEL_PROFILE = "quick-tunnel";
const UPDATE_UNSUPPORTED_EXIT_CODE = 64;

export interface RelayAutoUpdaterOptions {
  enabled: boolean;
  profileName: string;
  relayName: string;
  runningVersion: string;
  logger: Logger;
  packagedRuntime?: boolean;
  spawnRunner?: (args: readonly string[]) => ChildProcess;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

export interface RelayAutoUpdater {
  considerRelayVersion(version: string): void;
  dispose(): void;
}

export function createRelayAutoUpdater(options: RelayAutoUpdaterOptions): RelayAutoUpdater {
  const packagedRuntime = options.packagedRuntime ?? !IS_DEV;
  const available =
    options.enabled && packagedRuntime && options.profileName !== QUICK_TUNNEL_PROFILE;
  const retryInitialMs = options.retryInitialMs ?? UPDATE_RETRY_INITIAL_MS;
  const retryMaxMs = options.retryMaxMs ?? UPDATE_RETRY_MAX_MS;
  const spawnRunner =
    options.spawnRunner ??
    ((args: readonly string[]) =>
      spawnScript("update-runner", args, {
        env: { ...process.env },
        stdio: "ignore",
      }));

  let targetVersion: string | null = null;
  let runner: ChildProcess | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let disposed = false;

  const clearRetry = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer || !targetVersion) return;
    const delay = Math.min(retryInitialMs * 2 ** retryAttempt, retryMaxMs);
    retryAttempt++;
    options.logger.warn(
      { targetVersion, retryInMs: delay, attempt: retryAttempt },
      "Proxy auto-update will retry",
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startRunner();
    }, delay);
    retryTimer.unref?.();
  };

  const startRunner = () => {
    if (disposed || runner || !targetVersion) return;
    const runnerTargetVersion = targetVersion;
    const args = [
      "--profile",
      options.profileName,
      "--target-version",
      runnerTargetVersion,
      "--running-version",
      options.runningVersion,
      "--relay",
      options.relayName,
    ];
    options.logger.info(
      { runningVersion: options.runningVersion, targetVersion: runnerTargetVersion },
      "Starting Relay-directed Proxy auto-update",
    );
    try {
      runner = spawnRunner(args);
    } catch (error) {
      options.logger.error({ error: String(error), targetVersion }, "Unable to spawn auto-updater");
      scheduleRetry();
      return;
    }

    let settled = false;
    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      runner = null;
      if (code === 0) {
        retryAttempt = 0;
        options.logger.info(
          { targetVersion: runnerTargetVersion },
          "Proxy auto-update runner finished",
        );
        if (targetVersion && compareStableVersions(targetVersion, runnerTargetVersion) === 1) {
          startRunner();
        }
        return;
      }
      if (code === UPDATE_UNSUPPORTED_EXIT_CODE) {
        options.logger.warn(
          { targetVersion: runnerTargetVersion },
          "Automatic Proxy update is unsupported for this installation; manual update required",
        );
        return;
      }
      options.logger.error(
        { code, error: error ? String(error) : undefined, targetVersion: runnerTargetVersion },
        "Proxy auto-update runner failed",
      );
      scheduleRetry();
    };
    runner.once("error", (error) => finish(null, error));
    runner.once("exit", (code) => finish(code));
  };

  return {
    considerRelayVersion(version: string) {
      if (!available || disposed) return;
      const comparison = compareStableVersions(version, options.runningVersion);
      if (comparison === null) {
        options.logger.warn(
          { relayVersion: version },
          "Ignoring invalid Relay version for auto-update",
        );
        return;
      }
      if (comparison <= 0) return;

      if (targetVersion) {
        const targetComparison = compareStableVersions(version, targetVersion);
        if (targetComparison !== null && targetComparison <= 0) return;
      }
      targetVersion = version;
      retryAttempt = 0;
      clearRetry();
      startRunner();
    },
    dispose() {
      disposed = true;
      clearRetry();
    },
  };
}
