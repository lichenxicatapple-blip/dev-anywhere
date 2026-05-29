import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { resolveExecutable } from "./path-resolver.js";

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

function codexThemeArgs(terminalTheme?: ProviderTerminalOptions["terminalTheme"]): string[] {
  if (terminalTheme === "light") return ["-c", 'tui.theme="OneHalfLight"'];
  if (terminalTheme === "dark") return ["-c", 'tui.theme="OneHalfDark"'];
  return [];
}

function withCodexTerminalThemeArgs(
  args: string[],
  terminalTheme?: ProviderTerminalOptions["terminalTheme"],
): string[] {
  return [...codexThemeArgs(terminalTheme), ...args];
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  return resolveExecutable(
    "codex",
    env,
    "CODEX_BIN",
    "codex not found in PATH. Set CODEX_BIN or install Codex CLI.",
  );
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
  buildJsonCommand(_options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCodexCommand(env),
      args: ["app-server", "--listen", "stdio://"],
      env,
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const args = withCodexTerminalThemeArgs(
      withCodexTerminalPermissionArgs(options.args, options.permissionMode),
      options.terminalTheme,
    );
    return {
      command: resolveCodexCommand(env),
      args,
      env,
    };
  },
};
