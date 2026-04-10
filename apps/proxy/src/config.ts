import { existsSync, readFileSync } from "node:fs";

const CONFIG_PATH = `${process.env.HOME}/.cc-anywhere/config.json`;

export interface ProxyConfig {
  relayUrl?: string;
}

export function loadConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
  } catch {
    return {};
  }
}
