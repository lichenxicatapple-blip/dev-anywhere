export type PickerMode = "insert" | "select";

interface PickerTarget {
  currentPath: string;
  query: string;
}

export function withTrailingSlash(path: string): string {
  if (!path || path.endsWith("/")) return path;
  return `${path}/`;
}

function extractInsertQuery(filter: string): string {
  const afterAt = filter.split("@").pop() ?? "";
  const lastSlash = afterAt.lastIndexOf("/");
  return lastSlash >= 0 ? afterAt.slice(lastSlash + 1).toLowerCase() : afterAt.toLowerCase();
}

function extractInsertPath(filter: string): string {
  const afterAt = filter.split("@").pop() ?? "";
  const lastSlash = afterAt.lastIndexOf("/");
  return lastSlash >= 0 ? afterAt.slice(0, lastSlash + 1) : "";
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith("/")) return "";
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function resolveSelectPath(filter: string, baseCwd: string): string {
  if (filter.startsWith("/")) return normalizeAbsolutePath(filter);
  if (!baseCwd) return "";
  return normalizeAbsolutePath(`${baseCwd}/${filter}`);
}

export function resolvePickerTarget(
  filter: string,
  mode: PickerMode,
  options?: {
    baseCwd?: string;
    knownDirs?: ReadonlySet<string>;
  },
): PickerTarget {
  if (mode === "insert") {
    return {
      currentPath: extractInsertPath(filter) || "./",
      query: extractInsertQuery(filter),
    };
  }

  const baseCwd = normalizeAbsolutePath(options?.baseCwd ?? "");
  if (!filter) {
    return { currentPath: baseCwd ? withTrailingSlash(baseCwd) : "", query: "" };
  }

  const normalized = resolveSelectPath(filter.replace(/\/+$/, "") || "/", baseCwd);
  if (!normalized) return { currentPath: "", query: "" };
  const isKnownDir =
    filter.endsWith("/") || normalized === baseCwd || options?.knownDirs?.has(normalized);
  if (isKnownDir) {
    return { currentPath: withTrailingSlash(normalized), query: "" };
  }

  const lastSlash = normalized.lastIndexOf("/");
  return {
    currentPath: normalized.slice(0, lastSlash + 1) || "/",
    query: normalized.slice(lastSlash + 1).toLowerCase(),
  };
}
