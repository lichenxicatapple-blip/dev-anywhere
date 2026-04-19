import { existsSync, readFileSync } from "node:fs";

const CONFIG_PATH = `${process.env.HOME}/.cc-anywhere/config.json`;

export interface ProxyConfig {
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
}

export function loadConfig(): ProxyConfig {
  const fromFile: ProxyConfig = existsSync(CONFIG_PATH)
    ? (() => {
        try {
          return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfig;
        } catch {
          return {};
        }
      })()
    : {};
  return {
    relayUrl: process.env.RELAY_URL ?? fromFile.relayUrl,
    relayToken: process.env.RELAY_PROXY_TOKEN ?? fromFile.relayToken,
  };
}
