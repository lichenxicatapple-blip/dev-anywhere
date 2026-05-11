import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { CONFIG_PATH, PROFILE_NAME, defaultHookPortForProfile } from "./paths.js";
import { serviceLogger } from "./logger.js";
import { VALID_LOG_LEVELS, loadProxyRuntimeEnv } from "./runtime-env.js";
import type { ProviderId } from "../providers/types.js";

export type { LogLevel } from "./runtime-env.js";

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

const LogLevelSchema = z.enum(VALID_LOG_LEVELS);
// LogLevel 由 runtime-env.ts 定义并 re-export，schema 用同一组字面量保证两边对齐。

const RelayTargetSchema = z
  .object({
    url: z.string().optional(),
    proxyToken: z.string().optional(),
  })
  .strict();

const ProxyProfileSchema = z
  .object({
    relay: z.string().optional(),
  })
  .strict();

const AgentCliSchema = z
  .object({
    claudeBin: z.string().optional(),
    codexBin: z.string().optional(),
    claudeBinHistory: z.array(z.string()).optional(),
    codexBinHistory: z.array(z.string()).optional(),
  })
  .strict();

// .strict() 在顶层捕获拼错的字段（"relayss" / "profile"），但 profiles/relays 内部
// 是 record（用户定义键），不限制键名。
const ProxyConfigFileSchema = z
  .object({
    defaultProfile: z.string().optional(),
    profiles: z.record(z.string(), ProxyProfileSchema),
    relays: z.record(z.string(), RelayTargetSchema),
    agentCli: AgentCliSchema.optional(),
    previewRoots: z.array(z.string()).optional(),
    logLevel: LogLevelSchema.optional(),
  })
  .strict();

type ProxyConfigFile = z.infer<typeof ProxyConfigFileSchema>;
type RelayTargetConfig = z.infer<typeof RelayTargetSchema>;
type AgentCliConfig = z.infer<typeof AgentCliSchema>;

function readConfigFile(): ProxyConfigFile {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Dev Anywhere config not found at ${CONFIG_PATH}. Run "dev-anywhere init".`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const parsed = ProxyConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`Invalid config at ${CONFIG_PATH}:\n${issues}`);
  }
  return parsed.data;
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
  const env = loadProxyRuntimeEnv();
  const fromFile = readConfigFile();
  const agentCli = fromFile.agentCli ?? {};
  const resolved = resolveRelayConfig(fromFile, options?.relayName);
  const claudeBin = env.claudeBin ?? agentCli.claudeBin;
  const codexBin = env.codexBin ?? agentCli.codexBin;
  const config: ProxyConfig = {
    profileName: PROFILE_NAME,
    relayName: resolved.relayName,
    relayUrl: env.relayUrl ?? resolved.relay.url,
    relayToken: env.relayProxyToken ?? resolved.relay.proxyToken,
    hookPort: env.hookPort ?? defaultHookPortForProfile(PROFILE_NAME),
    claudeBin,
    codexBin,
    previewRoots: uniqueAbsolutePaths(fromFile.previewRoots ?? []),
    agentCliSuggestions: {
      claude: uniqueAbsolutePaths([
        env.claudeBin,
        agentCli.claudeBin,
        ...(agentCli.claudeBinHistory ?? []),
      ]),
      codex: uniqueAbsolutePaths([
        env.codexBin,
        agentCli.codexBin,
        ...(agentCli.codexBinHistory ?? []),
      ]),
    },
    sources: {
      relayName: resolved.relayNameSource,
      relayUrl: env.relayUrl ? "env" : resolved.relay.url ? "file" : "none",
      relayToken: env.relayProxyToken ? "env" : resolved.relay.proxyToken ? "file" : "none",
      hookPort: env.hookPort !== undefined ? "env" : "default",
      claudeBin: env.claudeBin ? "env" : agentCli.claudeBin ? "file" : "none",
      codexBin: env.codexBin ? "env" : agentCli.codexBin ? "file" : "none",
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
  // mode 0o600: config 文件含 relays[].proxyToken 等敏感字段, 不能让其他用户读到
  atomicWriteFileSync(CONFIG_PATH, `${JSON.stringify(fromFile, null, 2)}\n`, { mode: 0o600 });
}
