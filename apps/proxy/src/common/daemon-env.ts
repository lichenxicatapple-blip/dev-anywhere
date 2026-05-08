import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DESIRED_ENV_PATH } from "./paths.js";

export function setDesiredDaemonEnv(envName: string | undefined): void {
  const normalized = envName?.trim();
  if (normalized) {
    writeFileSync(DESIRED_ENV_PATH, `${normalized}\n`);
    return;
  }
  try {
    unlinkSync(DESIRED_ENV_PATH);
  } catch {
    // Missing desired-env file means "use config default".
  }
}

function readDesiredDaemonEnv(): string | undefined {
  if (!existsSync(DESIRED_ENV_PATH)) return undefined;
  const value = readFileSync(DESIRED_ENV_PATH, "utf-8").trim();
  return value || undefined;
}

export function daemonEnvArgs(envName?: string): string[] {
  const selected = envName?.trim() || readDesiredDaemonEnv();
  return selected ? ["--env", selected] : [];
}
