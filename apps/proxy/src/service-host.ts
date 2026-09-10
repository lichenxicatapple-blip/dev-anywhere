import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { IS_DEV, resolveTopLevelScript } from "./common/env.js";
import { tryAcquireFileLock } from "./common/file-lock.js";
import { removeLocalIpcEndpoint } from "./common/local-ipc-endpoint.js";
import { serviceLogger } from "./common/logger.js";
import {
  PROFILE_NAME,
  SERVICE_HOST_PATH,
  SERVICE_HOST_LOCK_PATH,
  ensureProfileWorkspace,
} from "./common/paths.js";
import {
  parseServiceCommandResult,
  type ServiceCommandResult,
} from "./common/service-command-result.js";
import { startServiceHostControl, type ServiceHostRequest } from "./common/service-host-control.js";

/** Always load the installed CLI afresh: the host can outlive an npm upgrade. */
function executeCommand(request: ServiceHostRequest): Promise<ServiceCommandResult> {
  const entry = `${fileURLToPath(resolveTopLevelScript("index"))}${IS_DEV ? ".ts" : ".js"}`;
  const args = [
    ...(IS_DEV ? ["--import", import.meta.resolve("tsx")] : []),
    entry,
    "--profile",
    PROFILE_NAME,
    "serve",
    "autostart",
    "exec",
    request.action,
    "--json",
    ...(request.relay ? ["--relay", request.relay] : []),
    ...(request.intent === "recover" ? ["--recover"] : []),
    ...(request.recoveryToken ? ["--recover-from", request.recoveryToken] : []),
  ];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: homedir(),
        env: { ...process.env },
        windowsHide: true,
        timeout: 80_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        const result = parseServiceCommandResult(stdout);
        resolve(
          result ?? {
            status: "failed",
            code: "COMMAND_FAILED",
            message: error?.killed
              ? "System service command timed out"
              : "System service command returned no valid result; check the service log",
          },
        );
      },
    );
  });
}

/** Runs in the OS service's session as the configured user, even while Proxy is stopped. */
export async function startSystemServiceHost(): Promise<void> {
  ensureProfileWorkspace();
  const lock = tryAcquireFileLock(SERVICE_HOST_LOCK_PATH);
  if (!lock) throw new Error("A system service host is already running for this profile");
  removeLocalIpcEndpoint(SERVICE_HOST_PATH);
  const active = new Set<Promise<ServiceCommandResult>>();
  const execute = (request: ServiceHostRequest) => {
    const pending = executeCommand(request);
    active.add(pending);
    void pending.finally(() => active.delete(pending));
    return pending;
  };
  let stopping = false;
  let startup: Promise<ServiceCommandResult> = Promise.resolve({ status: "stopped" });
  let control;
  try {
    control = await startServiceHostControl({
      endpoint: SERVICE_HOST_PATH,
      profile: PROFILE_NAME,
      execute: async (request) => {
        await startup;
        if (stopping)
          return { status: "failed", code: "STOPPED", message: "System service host is stopping" };
        return execute(request);
      },
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    control.close();
    await Promise.allSettled([...active]);
    const result = await execute({ action: "stop" });
    if (result.status === "failed")
      serviceLogger.error({ result }, "System service shutdown failed");
    removeLocalIpcEndpoint(SERVICE_HOST_PATH);
    lock.release();
    await flushLogger(serviceLogger);
    process.exit(result.status === "failed" ? 1 : 0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  if (process.platform === "win32") {
    // ServiceBase cannot deliver POSIX signals. Its private stdin pipe carries SCM stop/shutdown.
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.includes("\n") || input.length > 32) void shutdown();
    });
    process.stdin.once("end", () => void shutdown());
    process.stdin.resume();
  }
  // Loading a system service explicitly transfers Proxy ownership. Retained workers keep their
  // existing OS session; only workers created after this handover belong to the system service.
  startup = execute({ action: "restart", intent: "explicit" });
  const result = await startup;
  if (result.status === "failed") serviceLogger.error({ result }, "System service startup failed");
  else serviceLogger.info({ pid: process.pid, profile: PROFILE_NAME }, "System service host ready");
}
