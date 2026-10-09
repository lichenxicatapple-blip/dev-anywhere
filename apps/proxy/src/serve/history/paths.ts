import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const claudeProjectsDir = (): string => join(homedir(), ".claude", "projects");
export const codexSessionsDir = (): string => join(homedir(), ".codex", "sessions");
export function kimiSessionsDir(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return join(configured ? resolve(configured) : join(homedir(), ".kimi-code"), "sessions");
}

/** 与 Cursor CLI 相同的配置根目录规则：CURSOR_CONFIG_DIR > $XDG_CONFIG_HOME/cursor > ~/.cursor。 */
function cursorConfigDir(): string {
  const configured = process.env.CURSOR_CONFIG_DIR?.trim();
  if (configured) return resolve(configured);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(resolve(xdg), "cursor") : join(homedir(), ".cursor");
}

export function cursorAcpSessionsDir(): string {
  // 显式指定的历史目录优先，且直接作为历史目录使用，不再追加 acp-sessions。
  const explicit = process.env.CURSOR_ACP_SESSIONS_DIR?.trim();
  return explicit ? resolve(explicit) : join(cursorConfigDir(), "acp-sessions");
}
