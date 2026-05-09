import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { CONFIG_PATH, PROFILE_NAME, defaultHookPortForProfile } from "./paths.js";
import { serviceLogger } from "./logger.js";
import type { ProviderId } from "../providers/types.js";

export interface ProxyConfig {
  profileName: string;
  relayName: string;
  relayUrl?: string;
  // /proxy 端点的预共享 token, 和 relay 侧 RELAY_PROXY_TOKEN 对应. 公网 relay 必须设置
  relayToken?: string;
  hookPort?: number;
  claudeBin?: string;
  codexBin?: string;
  previewRoots: string[];
  agentCliSuggestions: Record<ProviderId, string[]>;
  sources: {
    relayName: "cli" | "profile";
    relayUrl: "env" | "file" | "none";
    relayToken: "env" | "file" | "none";
    hookPort: "env" | "default";
    claudeBin: "env" | "file" | "none";
    codexBin: "env" | "file" | "none";
  };
}

interface ProxyProfileConfig {
  relay?: string;
}

interface RelayTargetConfig {
  url?: string;
  proxyToken?: string;
}

interface ProxyConfigFile {
  defaultProfile?: string;
  profiles: Record<string, ProxyProfileConfig | undefined>;
  relays: Record<string, RelayTargetConfig | undefined>;
  agentCli?: AgentCliConfig;
  previewRoots?: string[];
}

interface AgentCliConfig {
  claudeBin?: string;
  codexBin?: string;
  claudeBinHistory?: string[];
  codexBinHistory?: string[];
}

function parsePort(value: string | undefined, source: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${source}: expected TCP port 1-65535`);
  }
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfigShape(value: unknown): ProxyConfigFile {
  if (!isRecord(value) || !isRecord(value.profiles) || !isRecord(value.relays)) {
    throw new Error(`Invalid config shape in ${CONFIG_PATH}: expected "profiles" and "relays".`);
  }
  return value as unknown as ProxyConfigFile;
}

function readConfigFile(): ProxyConfigFile {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Dev Anywhere config not found at ${CONFIG_PATH}. Run "dev-anywhere init".`);
  }
  return validateConfigShape(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
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

function resolveRelayConfig(
  fromFile: ProxyConfigFile,
  requestedRelayName?: string,
): {
  relayName: string;
  relayNameSource: ProxyConfig["sources"]["relayName"];
  relay: RelayTargetConfig;
} {
  const profile = fromFile.profiles[PROFILE_NAME];
  if (!profile) {
    const available = Object.keys(fromFile.profiles).sort();
    throw new Error(
      `Unknown profile "${PROFILE_NAME}". Available profiles: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }

  const relayName = requestedRelayName?.trim() || profile.relay?.trim();
  if (!relayName) {
    throw new Error(`Profile "${PROFILE_NAME}" must specify a relay.`);
  }

  const relay = fromFile.relays[relayName];
  if (!relay) {
    const available = Object.keys(fromFile.relays).sort();
    throw new Error(
      `Unknown relay "${relayName}". Available relays: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }

  return {
    relayName,
    relayNameSource: requestedRelayName?.trim() ? "cli" : "profile",
    relay,
  };
}

export function loadConfig(options?: { relayName?: string }): ProxyConfig {
  const fromFile = readConfigFile();
  const agentCli = fromFile.agentCli ?? {};
  const resolved = resolveRelayConfig(fromFile, options?.relayName);
  const claudeBin = process.env.CLAUDE_BIN ?? agentCli.claudeBin;
  const codexBin = process.env.CODEX_BIN ?? agentCli.codexBin;
  const config: ProxyConfig = {
    profileName: PROFILE_NAME,
    relayName: resolved.relayName,
    relayUrl: process.env.RELAY_URL ?? resolved.relay.url,
    relayToken: process.env.RELAY_PROXY_TOKEN ?? resolved.relay.proxyToken,
    hookPort:
      parsePort(process.env.DEV_ANYWHERE_HOOK_PORT, "DEV_ANYWHERE_HOOK_PORT") ??
      defaultHookPortForProfile(PROFILE_NAME),
    claudeBin,
    codexBin,
    previewRoots: uniqueAbsolutePaths(fromFile.previewRoots ?? []),
    agentCliSuggestions: {
      claude: uniqueAbsolutePaths([
        process.env.CLAUDE_BIN,
        agentCli.claudeBin,
        ...(agentCli.claudeBinHistory ?? []),
      ]),
      codex: uniqueAbsolutePaths([
        process.env.CODEX_BIN,
        agentCli.codexBin,
        ...(agentCli.codexBinHistory ?? []),
      ]),
    },
    sources: {
      relayName: resolved.relayNameSource,
      relayUrl: process.env.RELAY_URL ? "env" : resolved.relay.url ? "file" : "none",
      relayToken: process.env.RELAY_PROXY_TOKEN
        ? "env"
        : resolved.relay.proxyToken
          ? "file"
          : "none",
      hookPort: process.env.DEV_ANYWHERE_HOOK_PORT ? "env" : "default",
      claudeBin: process.env.CLAUDE_BIN ? "env" : agentCli.claudeBin ? "file" : "none",
      codexBin: process.env.CODEX_BIN ? "env" : agentCli.codexBin ? "file" : "none",
    },
  };

  serviceLogger.info(
    {
      profile: config.profileName,
      relayName: config.relayName,
      relayNameSource: config.sources.relayName,
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

function updateAgentCliConfig(
  config: AgentCliConfig,
  provider: ProviderId,
  path: string,
): AgentCliConfig {
  const field = agentCliField(provider);
  const historyField = agentCliHistoryField(provider);
  const history = uniqueAbsolutePaths([path, ...(config[historyField] ?? [])]).slice(0, 8);
  return {
    ...config,
    [field]: path,
    [historyField]: history,
  };
}

export function saveAgentCliPath(provider: ProviderId, path: string): void {
  const normalized = validateAgentCliPath(path);
  const fromFile = readConfigFile();
  fromFile.agentCli = updateAgentCliConfig(fromFile.agentCli ?? {}, provider, normalized);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(fromFile, null, 2)}\n`, "utf-8");
}
