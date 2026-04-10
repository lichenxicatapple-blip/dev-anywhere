// 目录路径操作纯函数，独立于 React 组件方便测试

// 将路径拆分成面包屑段落
export function buildBreadcrumbSegments(
  path: string,
): Array<{ label: string; path: string }> {
  if (path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((part, i) => ({
      label: part,
      path: "/" + parts.slice(0, i + 1).join("/"),
    })),
  ];
}

// 获取父级路径
export function buildParentPath(path: string): string {
  if (path === "/") return "/";
  const parent = path.substring(0, path.lastIndexOf("/"));
  return parent || "/";
}

// 拼接路径
export function joinPath(base: string, child: string): string {
  return base === "/" ? `/${child}` : `${base}/${child}`;
}
