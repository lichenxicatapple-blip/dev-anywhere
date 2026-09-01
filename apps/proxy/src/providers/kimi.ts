import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { resolveExecutable } from "./path-resolver.js";

export class KimiPermissionModeUnsupportedError extends Error {
  constructor(permissionMode: string) {
    super(`Kimi Code 不支持审批策略“${permissionMode}”。请刷新页面后重新选择。`);
    this.name = "KimiPermissionModeUnsupportedError";
  }
}

export type KimiAcpMode = "default" | "plan" | "auto" | "yolo";

export function resolveKimiAcpMode(permissionMode?: string): KimiAcpMode {
  switch (permissionMode) {
    case undefined:
    case "default":
      return "default";
    case "auto":
      return "yolo";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "auto";
    default:
      throw new KimiPermissionModeUnsupportedError(permissionMode);
  }
}

export function buildKimiTerminalArgs(args: string[], permissionMode?: string): string[] {
  switch (permissionMode) {
    case undefined:
    case "default":
      return [...args];
    case "auto":
      return ["--yolo", ...args];
    case "plan":
      return ["--plan", ...args];
    case "bypassPermissions":
      return ["--auto", ...args];
    default:
      throw new KimiPermissionModeUnsupportedError(permissionMode);
  }
}

export function resolveKimiCommand(env: NodeJS.ProcessEnv): string {
  return resolveExecutable(
    "kimi",
    env,
    "KIMI_BIN",
    "kimi not found in PATH. Set KIMI_BIN or install Kimi Code CLI.",
  );
}

export const KIMI_PROVIDER: ProviderAdapter = {
  id: "kimi",
  displayName: "Kimi Code",
  capabilities: {
    supportsHooks: false,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(_options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveKimiCommand(env),
      args: ["acp"],
      env,
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveKimiCommand(env),
      args: buildKimiTerminalArgs(options.args, options.permissionMode),
      env,
    };
  },
};
