import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import {
  DEFAULT_PROXY_PROFILE,
  PID_PATH,
  PROFILE_NAME,
  SOCK_PATH,
  SERVICE_CONTROL_PATH,
  SERVICE_RUNTIME_LOCK_PATH,
  STOPPED_PATH,
} from "../common/paths.js";
import { processExistsOrIsInaccessible } from "../common/process-probe.js";
import { unlinkIfPresent } from "../common/safe-unlink.js";
import { removeLocalIpcEndpoint } from "../common/local-ipc-endpoint.js";
import { tryConnectSocket } from "../common/socket-connect.js";
import { tryAcquireFileLock } from "../common/file-lock.js";

export function isProcessAlive(pid: number): boolean {
  return processExistsOrIsInaccessible(pid);
}

// The daemon holds this fd for its entire lifetime. No parent owns or transfers it,
// and no cleanup path removes the lock inode.
export async function claimServiceRuntime(): Promise<void> {
  const lock = tryAcquireFileLock(SERVICE_RUNTIME_LOCK_PATH);
  if (!lock) throw new Error("Another service is starting or running for this profile");
  const release = () => lock.release();
  try {
    if (existsSync(STOPPED_PATH)) throw new Error("Service was explicitly stopped");
    for (const path of [SOCK_PATH, SERVICE_CONTROL_PATH]) {
      const existing = await tryConnectSocket(path);
      if (existing) {
        existing.destroy();
        throw new Error(
          "A service is already using this profile. Stop it before starting another service.",
        );
      }
    }
    removeLocalIpcEndpoint(SOCK_PATH);
    removeLocalIpcEndpoint(SERVICE_CONTROL_PATH);
    unlinkIfPresent(PID_PATH);
    process.once("exit", release);
  } catch (error) {
    release();
    throw error;
  }
}

export function formatProxyNameForProfile(baseName: string, profileName = PROFILE_NAME): string {
  return profileName === DEFAULT_PROXY_PROFILE ? baseName : `${baseName} (${profileName})`;
}

export function getProxyName(): string {
  const explicitName = process.env.DEV_ANYWHERE_PROXY_NAME?.trim();
  if (explicitName) return explicitName;

  return formatProxyNameForProfile(getComputerName() || hostname());
}

function getComputerName(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return (
      execSync("scutil --get ComputerName", { stdio: ["pipe", "pipe", "ignore"] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}
