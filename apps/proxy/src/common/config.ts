import { existsSync, readFileSync } from "node:fs";
import { CONFIG_PATH } from "./paths.js";
import { serviceLogger } from "./logger.js";

interface ProxyConfig {
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
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
  };

  serviceLogger.info(
    {
      relayUrl: config.relayUrl ?? "(unset)",
      relayUrlSource: process.env.RELAY_URL
        ? "env"
        : fromFile.relayUrl
          ? "file"
          : "none",
      relayTokenSource: process.env.RELAY_PROXY_TOKEN
        ? "env"
        : fromFile.relayToken
          ? "file"
          : "none",
    },
    "Config loaded",
  );

  return config;
}
