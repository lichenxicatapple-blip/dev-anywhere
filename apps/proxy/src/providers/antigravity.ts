import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { environmentValue } from "../common/executable.js";
import { findExecutableCandidates, resolveExecutable } from "./path-resolver.js";
import type { ProviderAdapter } from "./types.js";

const NOT_FOUND =
  "Antigravity CLI (agy) not found. Set AGY_BIN or install it: https://antigravity.google/docs/getting-started?tab=cli";

export class AntigravityPermissionModeUnsupportedError extends Error {
  constructor(permissionMode: string) {
    super(`Antigravity CLI 不支持审批策略“${permissionMode}”。请刷新页面后重新选择。`);
  }
}

export function resolveAntigravityAcpMode(permissionMode?: string): string {
  switch (permissionMode) {
    case undefined:
    case "default":
    case "bypassPermissions":
      return "default";
    case "acceptEdits":
      return "accept-edits";
    case "auto":
    case "plan":
      return permissionMode;
    default:
      throw new AntigravityPermissionModeUnsupportedError(permissionMode);
  }
}

export function findAntigravityCandidates(env: NodeJS.ProcessEnv, cwd?: string): string[] {
  const defaultFolder =
    process.platform === "win32"
      ? join(
          environmentValue(env, "LOCALAPPDATA") || join(homedir(), "AppData", "Local"),
          "agy",
          "bin",
        )
      : join(environmentValue(env, "HOME") || homedir(), ".local", "bin");
  return [
    ...findExecutableCandidates("agy", env, { cwd }),
    ...(isAbsolute(defaultFolder)
      ? findExecutableCandidates(join(defaultFolder, "agy"), env, { cwd })
      : []),
  ];
}

export function resolveAntigravityCommand(env: NodeJS.ProcessEnv, cwd?: string): string {
  if (environmentValue(env, "AGY_BIN")?.trim()) {
    return resolveExecutable("agy", env, "AGY_BIN", NOT_FOUND, cwd);
  }
  const [command] = findAntigravityCandidates(env, cwd);
  if (!command) throw new Error(NOT_FOUND);
  return command;
}

function bypassFlags(permissionMode?: string): string[] {
  return permissionMode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
}

export const ANTIGRAVITY_PROVIDER: ProviderAdapter = {
  id: "antigravity",
  displayName: "Antigravity CLI",
  capabilities: {
    supportsHooks: false,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: false,
  },
  buildJsonCommand({ cwd, permissionMode }, env) {
    resolveAntigravityAcpMode(permissionMode);
    return {
      command: resolveAntigravityCommand(env, cwd),
      args: ["acp", ...bypassFlags(permissionMode)],
      env,
    };
  },
  buildTerminalCommand({ cwd, args, permissionMode }, env) {
    const command = resolveAntigravityCommand(env, cwd);
    // Local wrapper forwards the user's argv. Web-created terminals use browser scrollback.
    if (permissionMode === undefined) return { command, args: [...args], env };
    const mode = resolveAntigravityAcpMode(permissionMode);
    return {
      command,
      args: [
        "--settings",
        '{"altScreenMode":"never","clearScrollbackOnResize":false}',
        ...(mode === "default" ? [] : ["--mode", mode]),
        ...bypassFlags(permissionMode),
        ...args,
      ],
      env,
    };
  },
};
