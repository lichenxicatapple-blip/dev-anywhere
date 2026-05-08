import { execFileSync } from "node:child_process";
import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";

function codexApprovalArgs(permissionMode?: string): string[] {
  switch (permissionMode) {
    case undefined:
      return [];
    case "default":
      return ["--ask-for-approval", "untrusted"];
    case "auto":
      return ["--ask-for-approval", "on-request"];
    case "bypassPermissions":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    default:
      return ["--ask-for-approval", "untrusted"];
  }
}

function withCodexTerminalPermissionArgs(args: string[], permissionMode?: string): string[] {
  return [...codexApprovalArgs(permissionMode), ...args];
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  const custom = env.CODEX_BIN;
  if (custom) return custom;
  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("codex not found in PATH. Set CODEX_BIN or install Codex CLI.");
  }
}

export const CODEX_PROVIDER: ProviderAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  capabilities: {
    supportsHooks: true,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(_options: ProviderJsonOptions, _env: NodeJS.ProcessEnv): ProviderCommand {
    throw new Error("Codex JSON sessions are not supported yet; use PTY mode.");
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const args = withCodexTerminalPermissionArgs(options.args, options.permissionMode);
    return {
      command: resolveCodexCommand(env),
      args,
      env,
    };
  },
};
