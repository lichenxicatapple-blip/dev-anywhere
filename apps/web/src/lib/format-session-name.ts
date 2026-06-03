import type { SessionInfo } from "@dev-anywhere/shared";

// 格式化 session 名称：将长路径截断为易读的短路径
// ~/workspace/dev-anywhere/apps/proxy → ~/…/apps/proxy
// ~/my-project/ → ~/my-project
// ~/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined): string {
  if (!name) return "New Session";

  if (!name.startsWith("/") && !name.startsWith("~")) return name;

  const tildified = name.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, "~");
  const normalized = tildified.replace(/\/+$/, "") || "/";
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length <= 3) return normalized;

  const prefix = parts[0] === "~" ? "~" : "";
  const tail = parts.slice(-2).join("/");
  return `${prefix}/…/${tail}`;
}

export function formatUnlockedTerminalPathName(
  session: Pick<SessionInfo, "kind" | "name" | "cwd" | "nameLocked"> | undefined,
): string | undefined {
  if (!session || session.kind !== "terminal" || session.nameLocked) return undefined;
  const rawName = session.cwd ?? session.name;
  return rawName ? formatSessionName(rawName) : undefined;
}
