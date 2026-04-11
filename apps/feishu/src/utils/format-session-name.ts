// 格式化 session 名称：将长路径截断为易读的短路径
// ~/workspace/cc_anywhere/apps/proxy → ~/…/apps/proxy
// ~/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined): string {
  if (!name) return "New Session";

  // 不是路径，直接返回
  if (!name.startsWith("/") && !name.startsWith("~")) return name;

  const parts = name.split("/").filter(Boolean);

  // 3 级以内足够短，直接显示
  if (parts.length <= 3) return name;

  // 取最后两级，前面保留路径前缀
  const prefix = parts[0] === "~" ? "~" : "";
  const tail = parts.slice(-2).join("/");
  return `${prefix}/…/${tail}`;
}
