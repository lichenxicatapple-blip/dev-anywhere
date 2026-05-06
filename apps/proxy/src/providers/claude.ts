import { execFileSync } from "node:child_process";
import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";

export type ClaudePermissionMode =
  | "default"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

export function filterClaudeEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("CLAUDECODE")) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function buildClaudeArgs(options: {
  outputFormat?: string;
  inputFormat?: string;
  permissionPromptTool?: string;
  permissionMode?: ClaudePermissionMode;
  forkSession?: boolean;
  resumeSessionId?: string;
  verbose?: boolean;
  includePartialMessages?: boolean;
}): string[] {
  const args: string[] = [];
  if (options.outputFormat) args.push("--output-format", options.outputFormat);
  if (options.inputFormat) args.push("--input-format", options.inputFormat);
  args.push("--permission-prompt-tool", options.permissionPromptTool ?? "stdio");
  args.push("--permission-mode", options.permissionMode ?? "default");
  if (options.verbose) args.push("--verbose");
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.forkSession !== false) args.push("--fork-session");
  if (options.includePartialMessages) args.push("--include-partial-messages");
  return args;
}

export function resolveClaudePtyCommand(env: NodeJS.ProcessEnv): string {
  const custom = env.CLAUDE_BIN;
  if (custom) return custom;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "claude not found in PATH. Set CLAUDE_BIN or install Claude Code: https://claude.ai/download",
    );
  }
}

export function resolveClaudeJsonCommand(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_BIN || "claude";
}

export const CLAUDE_PROVIDER: ProviderAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: {
    supportsHooks: true,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const baseArgs = buildClaudeArgs({
      outputFormat: "stream-json",
      inputFormat: "stream-json",
      permissionPromptTool: "stdio",
      permissionMode: options.permissionMode as ClaudePermissionMode | undefined,
      verbose: true,
      forkSession: true,
      resumeSessionId: options.resumeSessionId,
      includePartialMessages: options.includePartialMessages,
    });

    return {
      command: resolveClaudeJsonCommand(env),
      args: [...baseArgs, ...(options.extraArgs ?? [])],
      env: filterClaudeEnvVars(env),
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveClaudePtyCommand(env),
      args: options.args,
      env,
    };
  },
};
