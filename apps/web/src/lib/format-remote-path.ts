import {
  normalizeRemoteAbsolutePath,
  remotePathRoot,
  remotePathSeparator,
  withTrailingSeparator,
} from "./remote-path";

// Display only: use the development machine's home and path semantics, never the browser's OS.
// Keep every directory by default; compact labels can opt into folding the middle directories.
export function formatRemotePath(
  path: string,
  homePath?: string,
  { compact = false }: { compact?: boolean } = {},
): string {
  const absolute = normalizeRemoteAbsolutePath(path, homePath);
  const home = homePath ? normalizeRemoteAbsolutePath(homePath) : "";
  const separator = remotePathSeparator(absolute || home, home);
  let root: string;
  let parts: string[];

  if (absolute) {
    root = remotePathRoot(absolute, home);
    parts = absolute.slice(root.length).split(separator).filter(Boolean);
    const pathKey = separator === "\\" ? absolute.toLowerCase() : absolute;
    const homeKey = separator === "\\" ? home.toLowerCase() : home;
    const homePrefix = withTrailingSeparator(homeKey);
    if (home && (pathKey === homeKey || pathKey.startsWith(homePrefix))) {
      root = `~${separator}`;
      parts = absolute.slice(homePrefix.length).split(separator).filter(Boolean);
    }
  } else if (
    path === "~" ||
    path.startsWith(`~${separator}`) ||
    (separator === "\\" && path.startsWith("~/"))
  ) {
    root = `~${separator}`;
    parts = (separator === "\\" ? path.replaceAll("/", "\\") : path)
      .slice(2)
      .split(separator)
      .filter(Boolean);
  } else {
    return path;
  }

  if (parts.length === 0) return root.startsWith("~") ? "~" : root;
  const visibleParts =
    compact && parts.length > (root.startsWith("~") ? 2 : 3) ? ["…", ...parts.slice(-2)] : parts;
  return root + visibleParts.join(separator);
}
