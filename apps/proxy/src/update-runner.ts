import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { autoUpdateLogger as logger } from "./common/logger.js";
import { AUTO_UPDATE_LOCK_PATH, PROFILE_NAME, STOPPED_PATH } from "./common/paths.js";
import { sanitizeProviderErrorTail } from "./common/codex-session-conflict.js";
import { parseServiceCommandResult } from "./common/service-command-result.js";
import { compareStableVersions, parseStableVersion } from "./common/stable-version.js";
import { spawnCommand } from "./common/command-launch.js";
import { terminateOwnedProcessTree } from "./common/process-termination.js";
import { PROXY_PACKAGE_NAME, PROXY_PACKAGE_ROOT } from "./version.js";

const LOCK_STALE_AFTER_MS = 30 * 60_000;
const INVALID_LOCK_GRACE_MS = 60_000;
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const NPM_ROOT_TIMEOUT_MS = 30_000;
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const CLI_VALIDATE_TIMEOUT_MS = 30_000;
const CLI_RESTART_TIMEOUT_MS = 90_000;
const LOCK_BUSY_EXIT_CODE = 75;
const UNSUPPORTED_EXIT_CODE = 64;

class UnsupportedAutoUpdateError extends Error {}

export interface RunnerOptions {
  targetVersion: string;
  runningVersion: string;
  relayName: string;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RestartRecoveryDeps {
  stopped(): boolean;
  runService(
    action: "start" | "restart",
    options: RunnerOptions,
    recoveryToken?: string,
  ): Promise<CommandResult>;
  installVersion(npm: string, version: string): Promise<void>;
  validateInstalledCli(version: string): Promise<void>;
}

export interface UpdateLock {
  release(): void;
}

export interface RelayDirectedUpdateDeps {
  acquireLock(): UpdateLock | null;
  resolveNpm(): string;
  verifyNpm(npm: string): Promise<void>;
  readInstalledVersion(): string;
  installVersion(npm: string, version: string): Promise<void>;
  validateInstalledCli(version: string): Promise<void>;
  restartWithRecovery(
    options: RunnerOptions,
    npm: string,
    previousInstalledVersion: string,
    installedByThisRun: boolean,
  ): Promise<void>;
}

export type UpdatePlan =
  | { kind: "none"; reason: "already-current" | "installed-ahead-of-relay" }
  | { kind: "restart"; version: string }
  | { kind: "install-and-restart"; version: string };

export function planRelayDirectedUpdate(options: {
  runningVersion: string;
  installedVersion: string;
  targetVersion: string;
}): UpdatePlan {
  const runningToTarget = compareStableVersions(options.runningVersion, options.targetVersion);
  const installedToTarget = compareStableVersions(options.installedVersion, options.targetVersion);
  if (runningToTarget === null || installedToTarget === null) {
    throw new Error("Auto-update requires stable x.y.z running, installed, and Relay versions");
  }
  if (runningToTarget >= 0) return { kind: "none", reason: "already-current" };
  if (installedToTarget > 0) {
    return { kind: "none", reason: "installed-ahead-of-relay" };
  }
  if (installedToTarget === 0) return { kind: "restart", version: options.targetVersion };
  return { kind: "install-and-restart", version: options.targetVersion };
}

function appendTail(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= COMMAND_OUTPUT_LIMIT ? combined : combined.slice(-COMMAND_OUTPUT_LIMIT);
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  killTreeOnTimeout = false,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawnCommand(command, [...args], {
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolveCommand({ code, signal, stdout, stderr, timedOut });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // Only npm owns all its descendants. A service command may have started a
      // daemon whose retained sessions must outlive this short-lived CLI process.
      const terminate = (signal: NodeJS.Signals) =>
        killTreeOnTimeout ? terminateOwnedProcessTree(child, signal) : child.kill(signal);
      terminate("SIGTERM");
      forceTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

function commandFailure(label: string, result: CommandResult): Error {
  const output = `${result.stderr}\n${result.stdout}`;
  const diagnostic = sanitizeProviderErrorTail(output);
  const reason = result.timedOut
    ? "timed out"
    : `exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
  return new Error(`${label} ${reason}${diagnostic ? `:\n${diagnostic}` : ""}`);
}

function adjacentNpmExecutable(): string {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const adjacent = join(dirname(process.execPath), executable);
  return existsSync(adjacent) ? adjacent : executable;
}

function canonicalPath(path: string): string {
  const canonical = realpathSync(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function verifyNpmManagedGlobalInstall(npm: string): Promise<void> {
  const result = await runCommand(
    npm,
    ["root", "--global", "--loglevel=error"],
    NPM_ROOT_TIMEOUT_MS,
    true,
  );
  if (result.code !== 0 || result.timedOut) throw commandFailure("npm root --global", result);
  const npmRoot = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!npmRoot) throw new Error("npm root --global returned an empty path");

  const expectedPackageRoot = join(npmRoot, ...PROXY_PACKAGE_NAME.split("/"));
  if (!existsSync(expectedPackageRoot)) {
    throw new UnsupportedAutoUpdateError(
      `npm does not manage ${PROXY_PACKAGE_NAME} in its global root`,
    );
  }
  if (lstatSync(expectedPackageRoot).isSymbolicLink()) {
    throw new UnsupportedAutoUpdateError("Auto-update is disabled for linked Proxy installations");
  }
  if (canonicalPath(expectedPackageRoot) !== canonicalPath(PROXY_PACKAGE_ROOT)) {
    throw new UnsupportedAutoUpdateError(
      "The active Proxy and adjacent npm use different global installation roots",
    );
  }
}

function readInstalledVersion(): string {
  const parsed = JSON.parse(readFileSync(join(PROXY_PACKAGE_ROOT, "package.json"), "utf-8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || !parseStableVersion(parsed.version)) {
    throw new Error("The installed Proxy package does not have a stable x.y.z version");
  }
  return parsed.version;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRecord(path: string): { pid?: number; createdAt?: number } {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { pid?: number; createdAt?: number };
  } catch {
    return {};
  }
}

export function acquireUpdateLock(
  path = AUTO_UPDATE_LOCK_PATH,
  now = Date.now(),
): UpdateLock | null {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const recordText = JSON.stringify({ pid: process.pid, createdAt: now });
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, recordText, "utf-8");
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          try {
            if (readFileSync(path, "utf-8") === recordText) unlinkSync(path);
          } catch {
            // 进程退出时锁已不存在或被替换，不应删除别人的锁。
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = readLockRecord(path);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const ageMs = Math.max(0, now - mtimeMs);
      const validPid = Number.isSafeInteger(record.pid) && (record.pid ?? 0) > 0;
      const live = validPid && processIsAlive(record.pid!);
      const stale = live
        ? ageMs >= LOCK_STALE_AFTER_MS
        : validPid || ageMs >= INVALID_LOCK_GRACE_MS;
      if (!stale) return null;
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseRunnerOptions(argv: readonly string[]): RunnerOptions {
  const readValue = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`Missing ${flag}`);
    return value;
  };
  const targetVersion = readValue("--target-version");
  const runningVersion = readValue("--running-version");
  const relayName = readValue("--relay");
  if (!parseStableVersion(targetVersion) || !parseStableVersion(runningVersion)) {
    throw new Error("Auto-update versions must use stable x.y.z syntax");
  }
  return { targetVersion, runningVersion, relayName };
}

export async function installVersion(npm: string, version: string): Promise<void> {
  const result = await runCommand(
    npm,
    [
      "install",
      "--global",
      `${PROXY_PACKAGE_NAME}@${version}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    NPM_INSTALL_TIMEOUT_MS,
    true,
  );
  if (result.code !== 0 || result.timedOut) {
    throw commandFailure(`npm install ${PROXY_PACKAGE_NAME}@${version}`, result);
  }
  const installed = readInstalledVersion();
  if (installed !== version) {
    throw new Error(`npm reported success, but installed Proxy version is ${installed}`);
  }
}

function proxyCliPath(): string {
  return join(PROXY_PACKAGE_ROOT, "dist", "index.js");
}

async function validateInstalledCli(version: string): Promise<void> {
  const result = await runCommand(
    process.execPath,
    [proxyCliPath(), "--version"],
    CLI_VALIDATE_TIMEOUT_MS,
  );
  if (result.code !== 0 || result.timedOut)
    throw commandFailure("updated Proxy validation", result);
  if (result.stdout.trim() !== version) {
    throw new Error(`Updated Proxy validation returned ${JSON.stringify(result.stdout.trim())}`);
  }
}

function relayArgs(relayName: string): string[] {
  return relayName ? ["--relay", relayName] : [];
}

export async function runProxyServiceCommand(
  action: "start" | "restart",
  options: RunnerOptions,
  recoveryToken?: string,
): Promise<CommandResult> {
  return runCommand(
    process.execPath,
    [
      proxyCliPath(),
      "--profile",
      PROFILE_NAME,
      "serve",
      action,
      "--json",
      ...(action === "restart" ? ["--if-running"] : []),
      ...relayArgs(options.relayName),
      ...(recoveryToken !== undefined ? ["--recover-from", recoveryToken] : []),
    ],
    CLI_RESTART_TIMEOUT_MS,
  );
}

export async function restartWithRecovery(
  options: RunnerOptions,
  npm: string,
  previousInstalledVersion: string,
  installedByThisRun: boolean,
  deps?: RestartRecoveryDeps,
): Promise<void> {
  const runtime: RestartRecoveryDeps = deps ?? {
    stopped: () => existsSync(STOPPED_PATH),
    runService: runProxyServiceCommand,
    installVersion,
    validateInstalledCli,
  };
  if (runtime.stopped()) {
    logger.info(
      { targetVersion: options.targetVersion },
      "Proxy was stopped during auto-update; package updated without restarting service",
    );
    return;
  }

  const result = await runtime.runService("restart", options);
  const restart =
    !result.timedOut && result.signal === null ? parseServiceCommandResult(result.stdout) : null;
  if (restart?.status === "ready") {
    if (restart.missingSessionIds.length > 0) {
      logger.warn(
        { targetVersion: options.targetVersion, missingSessionIds: restart.missingSessionIds },
        "Proxy updated and restarted, but some sessions did not reconnect",
      );
    }
    return;
  }
  if (restart?.status === "failed" && restart.code === "STOPPED") {
    logger.info("Proxy stop state changed during auto-update; restart was cancelled");
    return;
  }
  if (
    !installedByThisRun ||
    restart?.status !== "failed" ||
    restart.code !== "START_FAILED" ||
    restart.recoveryToken === undefined
  ) {
    // Only the lifecycle owner can confirm that startup failed safely and authorize recovery.
    // Missing/invalid output, a failed stop, or an unmanageable service is not that confirmation.
    throw commandFailure("Proxy auto-update restart", result);
  }

  logger.error(
    { targetVersion: options.targetVersion, rollbackVersion: previousInstalledVersion },
    "Updated Proxy did not become ready; rolling package back",
  );
  await runtime.installVersion(npm, previousInstalledVersion);
  await runtime.validateInstalledCli(previousInstalledVersion);
  // The lifecycle owner checks this token while holding its operation lock. A later user stop
  // replaces the token, so package rollback cannot override that stop by starting the service.
  const recovery = await runtime.runService("start", options, restart.recoveryToken);
  const recovered =
    !recovery.timedOut && recovery.signal === null
      ? parseServiceCommandResult(recovery.stdout)
      : null;
  if (recovered?.status === "failed" && recovered.code === "STOPPED") {
    throw new Error(
      `Proxy ${options.targetVersion} failed to start; restored ${previousInstalledVersion}; service recovery was cancelled because the stop state changed`,
    );
  }
  if (recovered?.status !== "ready") {
    throw commandFailure("Proxy rollback start", recovery);
  }
  throw new Error(
    `Proxy ${options.targetVersion} failed to start; restored ${previousInstalledVersion}`,
  );
}

export async function runRelayDirectedUpdate(
  options: RunnerOptions,
  deps?: RelayDirectedUpdateDeps,
): Promise<number> {
  const runtime: RelayDirectedUpdateDeps = deps ?? {
    acquireLock: () => acquireUpdateLock(),
    resolveNpm: adjacentNpmExecutable,
    verifyNpm: verifyNpmManagedGlobalInstall,
    readInstalledVersion,
    installVersion,
    validateInstalledCli,
    restartWithRecovery,
  };
  const lock = runtime.acquireLock();
  if (!lock) {
    logger.info({ targetVersion: options.targetVersion }, "Another Proxy auto-update is active");
    return LOCK_BUSY_EXIT_CODE;
  }

  try {
    const npm = runtime.resolveNpm();
    await runtime.verifyNpm(npm);
    const installedVersion = runtime.readInstalledVersion();
    const plan = planRelayDirectedUpdate({
      runningVersion: options.runningVersion,
      installedVersion,
      targetVersion: options.targetVersion,
    });

    if (plan.kind === "none") {
      const log =
        plan.reason === "installed-ahead-of-relay"
          ? logger.warn.bind(logger)
          : logger.info.bind(logger);
      log(
        {
          runningVersion: options.runningVersion,
          installedVersion,
          relayVersion: options.targetVersion,
          reason: plan.reason,
        },
        plan.reason === "installed-ahead-of-relay"
          ? "Installed Proxy is newer than this Relay; leaving the running daemon unchanged"
          : "Proxy already matches this Relay version",
      );
      return 0;
    }

    const installedByThisRun = plan.kind === "install-and-restart";
    if (installedByThisRun) {
      logger.info(
        { from: installedVersion, to: plan.version },
        "Installing Relay-matched Proxy version",
      );
      try {
        await runtime.installVersion(npm, plan.version);
        await runtime.validateInstalledCli(plan.version);
      } catch (updateError) {
        logger.error(
          { from: installedVersion, to: plan.version },
          "Proxy package installation or validation failed; checking previous package",
        );
        let previousPackageIsIntact = false;
        try {
          previousPackageIsIntact = runtime.readInstalledVersion() === installedVersion;
          if (previousPackageIsIntact) {
            await runtime.validateInstalledCli(installedVersion);
          }
        } catch {
          previousPackageIsIntact = false;
        }
        if (!previousPackageIsIntact) {
          try {
            await runtime.installVersion(npm, installedVersion);
            await runtime.validateInstalledCli(installedVersion);
          } catch (rollbackError) {
            throw new AggregateError(
              [updateError, rollbackError],
              `Proxy ${plan.version} failed and package rollback to ${installedVersion} also failed`,
              { cause: rollbackError },
            );
          }
          throw new Error(
            `Proxy ${plan.version} failed package validation; restored ${installedVersion}`,
            { cause: updateError },
          );
        }
        throw new Error(
          `Proxy ${plan.version} update failed; previous package ${installedVersion} remains intact`,
          { cause: updateError },
        );
      }
    } else {
      await runtime.validateInstalledCli(plan.version);
    }
    await runtime.restartWithRecovery(options, npm, installedVersion, installedByThisRun);
    return 0;
  } finally {
    lock.release();
  }
}

function sanitizeUpdateError(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (pending.length > 0 && messages.length < 12) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      if (current.cause !== undefined) pending.push(current.cause);
    } else if (current !== undefined) {
      messages.push(String(current));
    }
  }
  return sanitizeProviderErrorTail(messages.join("\n")) || "auto-update failed";
}

async function main(): Promise<number> {
  let options: RunnerOptions;
  try {
    options = parseRunnerOptions(process.argv.slice(2));
  } catch (error) {
    logger.error({ error: String(error) }, "Invalid Proxy auto-update invocation");
    return 1;
  }

  try {
    return await runRelayDirectedUpdate(options);
  } catch (error) {
    const diagnostic = sanitizeUpdateError(error);
    const unsupported = error instanceof UnsupportedAutoUpdateError;
    logger[unsupported ? "warn" : "error"](
      { targetVersion: options.targetVersion, error: diagnostic },
      unsupported
        ? "This Proxy installation cannot be updated automatically; use the original package manager"
        : "Proxy auto-update failed; the current daemon was left running when possible",
    );
    return unsupported ? UNSUPPORTED_EXIT_CODE : 1;
  }
}

const isMainModule = process.argv[1] && /update-runner\.(?:js|ts)$/.test(resolve(process.argv[1]));

if (isMainModule) {
  void main().then(async (code) => {
    await flushLogger(logger, 1_000);
    process.exit(code);
  });
}
