import { existsSync, readFileSync } from "node:fs";
import { CONFIG_PATH } from "./paths.js";
import { serviceLogger } from "./logger.js";

interface ProxyConfig {
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
  hookPort?: number;
}

function parsePort(value: string | undefined, source: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source}: expected TCP port 1-65535`);
  }
  return port;
}

export function loadConfig(): ProxyConfig {
  let fromFile: ProxyConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
    } catch (err) {
      serviceLogger.warn(
        { path: CONFIG_PATH, err: err instanceof Error ? err.message : String(err) },
        "Failed to parse config file, falling back to env-only",
      );
    }
  } else {
    serviceLogger.debug({ path: CONFIG_PATH }, "Config file not found, using env-only");
  }

  const config: ProxyConfig = {
    relayUrl: process.env.RELAY_URL ?? fromFile.relayUrl,
    relayToken: process.env.RELAY_PROXY_TOKEN ?? fromFile.relayToken,
    hookPort:
      parsePort(process.env.DEV_ANYWHERE_HOOK_PORT, "DEV_ANYWHERE_HOOK_PORT") ??
      fromFile.hookPort ??
      17654,
  };

  serviceLogger.info(
    {
      relayUrl: config.relayUrl ?? "(unset)",
      relayUrlSource: process.env.RELAY_URL ? "env" : fromFile.relayUrl ? "file" : "none",
      relayTokenSource: process.env.RELAY_PROXY_TOKEN
        ? "env"
        : fromFile.relayToken
          ? "file"
          : "none",
      hookPort: config.hookPort,
      hookPortSource: process.env.DEV_ANYWHERE_HOOK_PORT
        ? "env"
        : fromFile.hookPort
          ? "file"
          : "default",
    },
    "Config loaded",
  );

  return config;
}
