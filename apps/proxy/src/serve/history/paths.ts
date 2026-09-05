import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const claudeProjectsDir = (): string => join(homedir(), ".claude", "projects");
export const codexSessionsDir = (): string => join(homedir(), ".codex", "sessions");
export function kimiSessionsDir(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return join(configured ? resolve(configured) : join(homedir(), ".kimi-code"), "sessions");
}
