import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DESIRED_RELAY_PATH } from "./paths.js";

export function setDesiredDaemonRelay(relayName: string | undefined): void {
  const normalized = relayName?.trim();
  if (normalized) {
    mkdirSync(dirname(DESIRED_RELAY_PATH), { recursive: true });
    writeFileSync(DESIRED_RELAY_PATH, `${normalized}\n`);
    return;
  }
  try {
    unlinkSync(DESIRED_RELAY_PATH);
  } catch {
    // Missing desired-relay file means "use the selected profile's relay".
  }
}

function readDesiredDaemonRelay(): string | undefined {
  if (!existsSync(DESIRED_RELAY_PATH)) return undefined;
  const value = readFileSync(DESIRED_RELAY_PATH, "utf-8").trim();
  return value || undefined;
}

export function daemonRelayArgs(relayName?: string): string[] {
  const selected = relayName?.trim() || readDesiredDaemonRelay();
  return selected ? ["--relay", selected] : [];
}
