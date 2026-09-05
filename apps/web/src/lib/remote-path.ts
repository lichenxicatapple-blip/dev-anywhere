interface AbsolutePath {
  root: string;
  separator: "/" | "\\";
  parts: string[];
}

// Paths belong to the remote development machine, never to the browser's OS.
function parseAbsolutePath(path: string, basePath?: string): AbsolutePath | null {
  if (!path || /[\0\r\n]/.test(path)) return null;
  const base = basePath ? parseAbsolutePath(basePath) : null;
  let root: string;
  let separator: "/" | "\\";
  let rest: string;
  const drive = /^([a-z]):[\\/]/i.exec(path);
  const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(path);
  if (drive) {
    root = `${drive[1].toUpperCase()}:\\`;
    separator = "\\";
    rest = path.slice(drive[0].length);
  } else if (unc && !(path.startsWith("//") && base?.separator === "/")) {
    if ([unc[1], unc[2]].some((part) => part === "." || part === "..")) return null;
    root = `\\\\${unc[1]}\\${unc[2]}\\`;
    separator = "\\";
    rest = path.slice(unc[0].length);
  } else if (path.startsWith("/")) {
    root = base?.separator === "\\" ? base.root : "/";
    separator = base?.separator ?? "/";
    rest = path;
  } else {
    return null;
  }
  const parts: string[] = [];
  for (const part of rest.split(separator === "\\" ? /[\\/]/ : /\//)) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return { root, separator, parts };
}

export function normalizeRemoteAbsolutePath(path: string, basePath?: string): string {
  const parsed = parseAbsolutePath(path, basePath);
  return parsed ? parsed.root + parsed.parts.join(parsed.separator) : "";
}

export function remotePathSeparator(path: string, basePath?: string): "/" | "\\" {
  return parseAbsolutePath(path, basePath)?.separator ?? "/";
}

export function withTrailingSeparator(path: string, basePath = path): string {
  if (!path) return path;
  const separator = remotePathSeparator(normalizeRemoteAbsolutePath(path, basePath) || basePath);
  const normalized = separator === "\\" ? path.replaceAll("/", "\\") : path;
  return normalized.endsWith(separator) ? normalized : `${normalized}${separator}`;
}

export function remoteParentDirectory(path: string, basePath?: string): string {
  const parsed = parseAbsolutePath(path, basePath);
  if (!parsed) return "";
  return parsed.root + parsed.parts.slice(0, -1).join(parsed.separator);
}

export function resolveRemotePath(basePath: string, path: string): string {
  const absolute = normalizeRemoteAbsolutePath(path, basePath);
  if (absolute) return absolute;
  // A drive-relative or root-relative Windows path depends on process-local state.
  if (/^[a-z]:/i.test(path) || path.startsWith("\\")) return "";
  const base = normalizeRemoteAbsolutePath(basePath);
  return base ? normalizeRemoteAbsolutePath(`${withTrailingSeparator(base)}${path}`) : "";
}

export function joinRemoteChildDirectory(parent: string, child: string): string | null {
  const base = normalizeRemoteAbsolutePath(parent.trim());
  const name = child.trim();
  if (!base || !name || /^[a-z]:/i.test(name) || /^[\\/]/.test(name)) return null;
  const windows = remotePathSeparator(base) === "\\";
  const trimmedName = name.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const parts = trimmedName.split(windows ? /[\\/]/ : /\//);
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return resolveRemotePath(base, trimmedName) || null;
}
