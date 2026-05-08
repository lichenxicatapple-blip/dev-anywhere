import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { CONFIG_PATH } from "./paths.js";
import { serviceLogger } from "./logger.js";
import type { ProviderId } from "../providers/types.js";

export interface ProxyConfig {
  envName?: string;
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
  hookPort?: number;
  claudeBin?: string;
  codexBin?: string;
  agentCliSuggestions: Record<ProviderId, string[]>;
  sources: {
    envName: "cli" | "file" | "single" | "default" | "none";
    relayUrl: "env" | "file" | "none";
    relayToken: "env" | "file" | "none";
    hookPort: "env" | "file" | "default";
    claudeBin: "env" | "file" | "none";
    codexBin: "env" | "file" | "none";
  };
}

interface ProxyEnvConfig {
  relayUrl?: string;
  relayToken?: string;
  hookPort?: number;
  claudeBin?: string;
  codexBin?: string;
  claudeBinHistory?: string[];
  codexBinHistory?: string[];
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

function readConfigFile(): ProxyConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProxyConfigFile;
}

function agentCliField(provider: ProviderId): "claudeBin" | "codexBin" {
  return provider === "claude" ? "claudeBin" : "codexBin";
}

function agentCliHistoryField(provider: ProviderId): "claudeBinHistory" | "codexBinHistory" {
  return provider === "claude" ? "claudeBinHistory" : "codexBinHistory";
}

function validateAgentCliPath(path: string): string {
  const normalized = path.trim();
  if (!normalized) throw new Error("请输入 CLI 路径");
  if (!isAbsolute(normalized)) throw new Error("CLI 路径必须是绝对路径");
  return normalized;
}

function uniqueAbsolutePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || !isAbsolute(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function updateAgentCliPathInEnvConfig(
  config: ProxyEnvConfig,
  provider: ProviderId,
  path: string,
): ProxyEnvConfig {
  const field = agentCliField(provider);
  const historyField = agentCliHistoryField(provider);
  const history = uniqueAbsolutePaths([path, ...(config[historyField] ?? [])]).slice(0, 8);
  return {
    ...config,
    [field]: path,
    [historyField]: history,
  };
}

export function loadConfig(options?: { envName?: string }): ProxyConfig {
  let fromFile: ProxyConfigFile = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fromFile = readConfigFile();
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
  const claudeBinFromFile = resolved.config.claudeBin ?? fromFile.claudeBin;
  const codexBinFromFile = resolved.config.codexBin ?? fromFile.codexBin;
  const claudeBinHistory = [
    ...(resolved.config.claudeBinHistory ?? []),
    ...(fromFile.claudeBinHistory ?? []),
  ];
  const codexBinHistory = [
    ...(resolved.config.codexBinHistory ?? []),
    ...(fromFile.codexBinHistory ?? []),
  ];
  const claudeBin = process.env.CLAUDE_BIN ?? claudeBinFromFile;
  const codexBin = process.env.CODEX_BIN ?? codexBinFromFile;
  const config: ProxyConfig = {
    envName: resolved.envName,
    relayUrl: process.env.RELAY_URL ?? resolved.config.relayUrl,
    relayToken: process.env.RELAY_PROXY_TOKEN ?? resolved.config.relayToken,
    hookPort:
      parsePort(process.env.DEV_ANYWHERE_HOOK_PORT, "DEV_ANYWHERE_HOOK_PORT") ??
      hookPortFromFile ??
      17654,
    claudeBin,
    codexBin,
    agentCliSuggestions: {
      claude: uniqueAbsolutePaths([process.env.CLAUDE_BIN, claudeBinFromFile, ...claudeBinHistory]),
      codex: uniqueAbsolutePaths([process.env.CODEX_BIN, codexBinFromFile, ...codexBinHistory]),
    },
    sources: {
      envName: resolved.envNameSource,
      relayUrl: process.env.RELAY_URL ? "env" : resolved.config.relayUrl ? "file" : "none",
      relayToken: process.env.RELAY_PROXY_TOKEN
        ? "env"
        : resolved.config.relayToken
          ? "file"
          : "none",
      hookPort: process.env.DEV_ANYWHERE_HOOK_PORT ? "env" : hookPortFromFile ? "file" : "default",
      claudeBin: process.env.CLAUDE_BIN ? "env" : claudeBinFromFile ? "file" : "none",
      codexBin: process.env.CODEX_BIN ? "env" : codexBinFromFile ? "file" : "none",
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
      claudeBinSource: config.sources.claudeBin,
      codexBinSource: config.sources.codexBin,
    },
    "Config loaded",
  );

  return config;
}

export function buildProviderEnv(
  config: ProxyConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(config.claudeBin ? { CLAUDE_BIN: config.claudeBin } : {}),
    ...(config.codexBin ? { CODEX_BIN: config.codexBin } : {}),
  };
}

export function saveAgentCliPath(
  provider: ProviderId,
  path: string,
  options?: { envName?: string },
): void {
  const normalized = validateAgentCliPath(path);
  const fromFile = readConfigFile();

  const resolved = resolveFileConfig(fromFile, options?.envName);
  if (fromFile.envs) {
    const envName = resolved.envName ?? options?.envName ?? fromFile.defaultEnv ?? "local";
    fromFile.envs[envName] = updateAgentCliPathInEnvConfig(
      fromFile.envs[envName] ?? {},
      provider,
      normalized,
    );
  } else {
    Object.assign(fromFile, updateAgentCliPathInEnvConfig(fromFile, provider, normalized));
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(fromFile, null, 2)}\n`, "utf-8");
}
