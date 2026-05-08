import { existsSync, readFileSync } from "node:fs";
import { CONFIG_PATH } from "./paths.js";
import { serviceLogger } from "./logger.js";

export interface ProxyConfig {
  envName?: string;
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
  hookPort?: number;
  sources: {
    envName: "cli" | "file" | "single" | "default" | "none";
    relayUrl: "env" | "file" | "none";
    relayToken: "env" | "file" | "none";
    hookPort: "env" | "file" | "default";
  };
}

interface ProxyEnvConfig {
  relayUrl?: string;
  relayToken?: string;
  hookPort?: number;
}

interface ProxyConfigFile extends ProxyEnvConfig {
  defaultEnv?: string;
  envs?: Record<string, ProxyEnvConfig | undefined>;
}

function parsePort(value: string | undefined, source: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source}: expected TCP port 1-65535`);
  }
  return port;
}

function resolveFileConfig(
  fromFile: ProxyConfigFile,
  requestedEnv?: string,
): {
  envName?: string;
  envNameSource: ProxyConfig["sources"]["envName"];
  config: ProxyEnvConfig;
} {
  if (!fromFile.envs) {
    return {
      envName: undefined,
      envNameSource:
        fromFile.relayUrl || fromFile.relayToken || fromFile.hookPort ? "single" : "none",
      config: fromFile,
    };
  }

  const envName = requestedEnv ?? fromFile.defaultEnv ?? "local";
  const config = fromFile.envs[envName];
  if (!config) {
    const available = Object.keys(fromFile.envs).sort();
    throw new Error(
      `Unknown config env "${envName}". Available envs: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }

  return {
    envName,
    envNameSource: requestedEnv ? "cli" : fromFile.defaultEnv ? "file" : "default",
    config,
  };
}

export function loadConfig(options?: { envName?: string }): ProxyConfig {
  let fromFile: ProxyConfigFile = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfigFile;
    } catch (err) {
      serviceLogger.warn(
        { path: CONFIG_PATH, err: err instanceof Error ? err.message : String(err) },
        "Failed to parse config file, falling back to env-only",
      );
    }
  } else {
    serviceLogger.debug({ path: CONFIG_PATH }, "Config file not found, using env-only");
  }

  const resolved = resolveFileConfig(fromFile, options?.envName);
  const hookPortFromFile = resolved.config.hookPort ?? fromFile.hookPort;
  const config: ProxyConfig = {
    envName: resolved.envName,
    relayUrl: process.env.RELAY_URL ?? resolved.config.relayUrl,
    relayToken: process.env.RELAY_PROXY_TOKEN ?? resolved.config.relayToken,
    hookPort:
      parsePort(process.env.DEV_ANYWHERE_HOOK_PORT, "DEV_ANYWHERE_HOOK_PORT") ??
      hookPortFromFile ??
      17654,
    sources: {
      envName: resolved.envNameSource,
      relayUrl: process.env.RELAY_URL ? "env" : resolved.config.relayUrl ? "file" : "none",
      relayToken: process.env.RELAY_PROXY_TOKEN
        ? "env"
        : resolved.config.relayToken
          ? "file"
          : "none",
      hookPort: process.env.DEV_ANYWHERE_HOOK_PORT ? "env" : hookPortFromFile ? "file" : "default",
    },
  };

  serviceLogger.info(
    {
      envName: config.envName ?? "(single)",
      envNameSource: config.sources.envName,
      relayUrl: config.relayUrl ?? "(unset)",
      relayUrlSource: config.sources.relayUrl,
      relayTokenSource: config.sources.relayToken,
      hookPort: config.hookPort,
      hookPortSource: config.sources.hookPort,
    },
    "Config loaded",
  );

  return config;
}
