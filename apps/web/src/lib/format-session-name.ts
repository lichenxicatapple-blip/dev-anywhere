// 格式化 session 名称：将长路径截断为易读的短路径
// ~/workspace/dev-anywhere/apps/proxy → ~/…/apps/proxy
// ~/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined): string {
  if (!name) return "New Session";

  if (!name.startsWith("/") && !name.startsWith("~")) return name;

  const normalized = name.replace(/^\/Users\/[^/]+/, "~");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length <= 3) return normalized;

  const prefix = parts[0] === "~" ? "~" : "";
  const tail = parts.slice(-2).join("/");
  return `${prefix}/…/${tail}`;
}
