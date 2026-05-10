import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { connect, type Socket } from "node:net";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { serviceLogger } from "../common/logger.js";
import { DEFAULT_PROXY_PROFILE, PID_PATH, PROFILE_NAME, SOCK_PATH } from "../common/paths.js";

function tryConnectSocket(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupStaleResources(): Promise<void> {
  if (existsSync(SOCK_PATH)) {
    const existing = await tryConnectSocket(SOCK_PATH);
    if (existing) {
      existing.destroy();
      const msg = `Another service is already running on ${SOCK_PATH}`;
      serviceLogger.error(msg);
      console.error(msg);
      await flushLogger(serviceLogger);
      process.exit(1);
    }
    unlinkSync(SOCK_PATH);
    serviceLogger.info("Removed stale socket file");
  }

  if (existsSync(PID_PATH)) {
    const pidStr = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      const msg = `Another service is already running with PID ${pid}`;
      serviceLogger.error(msg);
      console.error(msg);
      await flushLogger(serviceLogger);
      process.exit(1);
    }
    unlinkSync(PID_PATH);
    serviceLogger.info("Removed stale PID file");
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
