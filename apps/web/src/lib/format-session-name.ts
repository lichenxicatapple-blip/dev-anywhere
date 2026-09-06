import type { SessionInfo } from "@dev-anywhere/shared";
import {
  normalizeRemoteAbsolutePath,
  remotePathRoot,
  remotePathSeparator,
  withTrailingSeparator,
} from "./remote-path";

// 格式化 session 名称：将长路径截断为易读的短路径
// ~/workspace/dev-anywhere/apps/proxy → ~/…/apps/proxy
// ~/my-project/ → ~/my-project
// ~/my-project → ~/my-project
// /tmp/test → /tmp/test
export function formatSessionName(name: string | undefined, homePath?: string): string {
  if (!name) return "New Session";

  const absolute = normalizeRemoteAbsolutePath(name, homePath);
  const home = homePath ? normalizeRemoteAbsolutePath(homePath) : "";
  const separator = remotePathSeparator(absolute || home, home);
  let root: string;
  let parts: string[];

  if (absolute) {
    root = remotePathRoot(absolute, home);
    parts = absolute.slice(root.length).split(separator).filter(Boolean);
    // Only abbreviate the reported home, respecting directory boundaries and remote OS semantics.
    const pathKey = separator === "\\" ? absolute.toLowerCase() : absolute;
    const homeKey = separator === "\\" ? home.toLowerCase() : home;
    const homePrefix = withTrailingSeparator(homeKey);
    if (home && (pathKey === homeKey || pathKey.startsWith(homePrefix))) {
      root = `~${separator}`;
      parts = absolute.slice(homePrefix.length).split(separator).filter(Boolean);
    }
  } else if (
    name === "~" ||
    name.startsWith(`~${separator}`) ||
    (separator === "\\" && name.startsWith("~/"))
  ) {
    root = `~${separator}`;
    parts = (separator === "\\" ? name.replaceAll("/", "\\") : name)
      .slice(2)
      .split(separator)
      .filter(Boolean);
  } else {
    return name;
  }

  if (parts.length === 0) return root.startsWith("~") ? "~" : root;
  const visibleParts =
    parts.length > (root.startsWith("~") ? 2 : 3) ? ["…", ...parts.slice(-2)] : parts;
  return root + visibleParts.join(separator);
}

export function formatUnlockedTerminalPathName(
  session: Pick<SessionInfo, "kind" | "name" | "cwd" | "nameLocked"> | undefined,
  homePath?: string,
): string | undefined {
  if (!session || session.kind !== "terminal" || session.nameLocked) return undefined;
  return formatSessionName(session.cwd, homePath);
}
