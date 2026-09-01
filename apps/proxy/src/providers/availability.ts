import type { AgentCliAvailability, AgentCliStatus } from "@dev-anywhere/shared";
import { resolveClaudePtyCommand } from "./claude.js";
import { resolveCodexCommand } from "./codex.js";
import { resolveKimiCommand } from "./kimi.js";
import { findExecutableCandidates } from "./path-resolver.js";
import type { ProviderId } from "./types.js";

interface AgentCliStatusOptions {
  suggestions?: Partial<Record<ProviderId, string[]>>;
}

type DetectedAgentCliStatus = AgentCliStatus & { kimi: AgentCliAvailability };

const PROVIDER_BIN_NAME: Record<ProviderId, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
};
const PROVIDER_ENV_NAME: Record<ProviderId, "CLAUDE_BIN" | "CODEX_BIN" | "KIMI_BIN"> = {
  claude: "CLAUDE_BIN",
  codex: "CODEX_BIN",
  kimi: "KIMI_BIN",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function uniqueSuggestions(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function discoverProviderCandidates(provider: ProviderId, env: NodeJS.ProcessEnv): string[] {
  const envPath = env[PROVIDER_ENV_NAME[provider]];
  return uniqueSuggestions([
    envPath,
    ...findExecutableCandidates(PROVIDER_BIN_NAME[provider], env),
  ]);
}

function attachSuggestions(
  availability: Omit<AgentCliAvailability, "suggestions">,
  suggestions: string[],
): AgentCliAvailability {
  return suggestions.length > 0 ? { ...availability, suggestions } : availability;
}

function detect(resolve: () => string, suggestions: string[] = []): AgentCliAvailability {
  try {
    const command = resolve();
    return attachSuggestions(
      { available: true, command },
      uniqueSuggestions([command, ...suggestions]),
    );
  } catch (err) {
    return attachSuggestions(
      { available: false, error: errorMessage(err) },
      uniqueSuggestions(suggestions),
    );
  }
}

export function detectAgentCliStatus(
  env: NodeJS.ProcessEnv = process.env,
  options: AgentCliStatusOptions = {},
): DetectedAgentCliStatus {
  return {
    claude: detect(
      () => resolveClaudePtyCommand(env),
      [...discoverProviderCandidates("claude", env), ...(options.suggestions?.claude ?? [])],
    ),
    codex: detect(
      () => resolveCodexCommand(env),
      [...discoverProviderCandidates("codex", env), ...(options.suggestions?.codex ?? [])],
    ),
    // Shared 为滚动升级把该字段保持 optional；当前 Proxy 的探测结果始终完整上报 Kimi。
    kimi: detect(
      () => resolveKimiCommand(env),
      [...discoverProviderCandidates("kimi", env), ...(options.suggestions?.kimi ?? [])],
    ),
  };
}
