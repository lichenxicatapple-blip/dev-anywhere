import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { findExecutableCandidates, resolveExecutable } from "./path-resolver.js";
import { environmentValue } from "../common/executable.js";

export class CursorPermissionModeUnsupportedError extends Error {
  constructor(permissionMode: string) {
    super(`Cursor CLI 不支持审批策略“${permissionMode}”。请刷新页面后重新选择。`);
    this.name = "CursorPermissionModeUnsupportedError";
  }
}

export type CursorAcpMode = "agent" | "plan" | "ask";

/**
 * 聊天模式（ACP）的审批策略映射。
 *
 * 不支持 `auto`（智能自动）：终端模式的“智能自动”对应 `agent --auto-review`，由 Cursor
 * 服务端分类器自动放行安全调用、其余仍询问；但 `agent acp` 不接受任何命令行参数，ACP 对外
 * 只开放 agent / plan / ask 三种模式，没有 auto-review，因此聊天模式里选不到这项能力。
 * 如果把 `auto` 当作“全部允许”，用户选的是“只放行安全操作”，实际却是放行所有操作，
 * 所以必须拒绝，不能静默降级。终端模式不受影响，见 `resolveCursorPermissionFlags`。
 * 待确认 ACP 能遵循 auto-review 配置后再恢复（例如给 acp 进程配置独立的 CURSOR_CONFIG_DIR）。
 */
export function resolveCursorAcpMode(permissionMode?: string): CursorAcpMode {
  switch (permissionMode) {
    case undefined:
    case "default":
    case "bypassPermissions":
      return "agent";
    case "plan":
      return "plan";
    default:
      throw new CursorPermissionModeUnsupportedError(permissionMode);
  }
}

/** 聊天模式下只有“跳过全部审批”才自动批准工具；`auto` 在 resolveCursorAcpMode 里已被拒绝。 */
export function cursorAcpAutoApprovesPermissions(permissionMode?: string): boolean {
  return permissionMode === "bypassPermissions";
}

const CURSOR_NOT_FOUND_MESSAGE =
  "Cursor CLI not found in PATH. Set CURSOR_BIN or install Cursor CLI (the `agent` binary): https://cursor.com/cli";

export function resolveCursorPermissionFlags(permissionMode?: string): string[] {
  switch (permissionMode) {
    case undefined:
    case "default":
      return [];
    case "auto":
      return ["--auto-review"];
    case "plan":
      return ["--mode=plan"];
    case "bypassPermissions":
      return ["--yolo"];
    default:
      throw new CursorPermissionModeUnsupportedError(permissionMode);
  }
}

function insertBeforePromptSeparator(args: string[], extra: string[]): string[] {
  if (extra.length === 0) return [...args];
  const next = [...args];
  const separator = next.indexOf("--");
  next.splice(separator === -1 ? next.length : separator, 0, ...extra);
  return next;
}

export function buildCursorTerminalArgs(args: string[], permissionMode?: string): string[] {
  // Hosted PTY always sends a permissionMode (including "default"). Local wrap
  // leaves it unset so user argv stays untouched — including no `--trust`.
  if (permissionMode === undefined) return [...args];
  return insertBeforePromptSeparator(args, [
    "--trust",
    ...resolveCursorPermissionFlags(permissionMode),
  ]);
}

export function resolveCursorCommand(env: NodeJS.ProcessEnv, cwd?: string): string {
  const custom = environmentValue(env, "CURSOR_BIN")?.trim();
  if (custom) {
    return resolveExecutable("agent", env, "CURSOR_BIN", CURSOR_NOT_FOUND_MESSAGE, cwd);
  }
  const agent = findExecutableCandidates("agent", env, { cwd })[0];
  if (agent) return agent;
  const cursorAgent = findExecutableCandidates("cursor-agent", env, { cwd })[0];
  if (cursorAgent) return cursorAgent;
  throw new Error(CURSOR_NOT_FOUND_MESSAGE);
}

export const CURSOR_PROVIDER: ProviderAdapter = {
  id: "cursor",
  displayName: "Cursor CLI",
  capabilities: {
    supportsHooks: false,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCursorCommand(env, options.cwd),
      args: ["acp"],
      env,
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCursorCommand(env, options.cwd),
      args: buildCursorTerminalArgs(options.args, options.permissionMode),
      env,
    };
  },
};
