import type { AgentCliAvailability, AgentCliStatus } from "@dev-anywhere/shared";
import { resolveClaudePtyCommand } from "./claude.js";
import { resolveCodexCommand } from "./codex.js";
import { resolveCursorCommand } from "./cursor.js";
import { resolveKimiCommand } from "./kimi.js";
import { findExecutableCandidates } from "./path-resolver.js";
import type { ProviderId } from "./types.js";
import { environmentValue } from "../common/executable.js";

interface AgentCliStatusOptions {
  suggestions?: Partial<Record<ProviderId, string[]>>;
}

type DetectedAgentCliStatus = AgentCliStatus;

const PROVIDER_BIN_NAMES: Record<ProviderId, readonly string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  kimi: ["kimi"],
  cursor: ["agent", "cursor-agent"],
};
const PROVIDER_ENV_NAME: Record<ProviderId, "CLAUDE_BIN" | "CODEX_BIN" | "KIMI_BIN" | "CURSOR_BIN"> =
  {
    claude: "CLAUDE_BIN",
    codex: "CODEX_BIN",
    kimi: "KIMI_BIN",
    cursor: "CURSOR_BIN",
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
  const envPath = environmentValue(env, PROVIDER_ENV_NAME[provider]);
  return uniqueSuggestions([
    envPath,
    ...PROVIDER_BIN_NAMES[provider].flatMap((name) => findExecutableCandidates(name, env)),
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
    kimi: detect(
      () => resolveKimiCommand(env),
      [...discoverProviderCandidates("kimi", env), ...(options.suggestions?.kimi ?? [])],
    ),
    cursor: detect(
      () => resolveCursorCommand(env),
      [...discoverProviderCandidates("cursor", env), ...(options.suggestions?.cursor ?? [])],
    ),
  };
}
