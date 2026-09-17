import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { findExecutableCandidates, resolveExecutable } from "./path-resolver.js";
import { environmentValue } from "../common/executable.js";

export const CURSOR_JSON_UNSUPPORTED_MESSAGE = "Cursor CLI 目前仅支持终端模式";

export class CursorJsonUnsupportedError extends Error {
  constructor() {
    super(CURSOR_JSON_UNSUPPORTED_MESSAGE);
    this.name = "CursorJsonUnsupportedError";
  }
}

export class CursorPermissionModeUnsupportedError extends Error {
  constructor(permissionMode: string) {
    super(`Cursor CLI 不支持审批策略“${permissionMode}”。请刷新页面后重新选择。`);
    this.name = "CursorPermissionModeUnsupportedError";
  }
}

const CURSOR_NOT_FOUND_MESSAGE =
  "Cursor CLI not found in PATH. Set CURSOR_BIN or install the `agent` CLI: https://cursor.com/cli";

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
  return insertBeforePromptSeparator(args, ["--trust", ...resolveCursorPermissionFlags(permissionMode)]);
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
  buildJsonCommand(_options: ProviderJsonOptions, _env: NodeJS.ProcessEnv): ProviderCommand {
    throw new CursorJsonUnsupportedError();
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCursorCommand(env, options.cwd),
      args: buildCursorTerminalArgs(options.args, options.permissionMode),
      env,
    };
  },
};
