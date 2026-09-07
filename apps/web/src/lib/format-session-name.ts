import type { SessionInfo } from "@dev-anywhere/shared";
import { formatRemotePath } from "./format-remote-path";

// 格式化 session 名称：将长路径截断为易读的短路径
// ~/workspace/dev-anywhere/apps/proxy → ~/…/apps/proxy
// ~/my-project/ → ~/my-project
// ~/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined, homePath?: string): string {
  if (!name) return "New Session";
  return formatRemotePath(name, homePath, { compact: true });
}

export function formatUnlockedTerminalPathName(
  session: Pick<SessionInfo, "kind" | "name" | "cwd" | "nameLocked"> | undefined,
  homePath?: string,
): string | undefined {
  if (!session || session.kind !== "terminal" || session.nameLocked) return undefined;
  return formatSessionName(session.cwd, homePath);
}
