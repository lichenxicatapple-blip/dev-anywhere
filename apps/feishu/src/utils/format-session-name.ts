// 格式化 session 名称：将完整路径转为易读的短路径
// /Users/admin/workspace/cc_anywhere/apps/proxy → ~/…/apps/proxy
// /Users/admin/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined): string {
  if (!name) return "New Session";

  // 不是路径，直接返回
  if (!name.startsWith("/")) return name;

  // 替换 home 目录为 ~
  const home = typeof process !== "undefined" && process.env?.HOME;
  let path = name;
  if (home && path.startsWith(home)) {
    path = "~" + path.slice(home.length);
  }

  const parts = path.split("/").filter(Boolean);

  // 3 级以内足够短，直接显示
  if (parts.length <= 3) return path;

  // 取最后两级，前面用 …
  const prefix = parts[0] === "~" ? "~" : "";
  const tail = parts.slice(-2).join("/");
  return `${prefix}/…/${tail}`;
}
