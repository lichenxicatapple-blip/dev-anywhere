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

  if (!filter) {
    return { currentPath: "./", query: "" };
  }

  const normalized = filter.replace(/\/+$/, "") || "/";
  const isKnownDir =
    filter.endsWith("/") || normalized === options?.baseCwd || options?.knownDirs?.has(normalized);
  if (isKnownDir) {
    return { currentPath: withTrailingSlash(normalized), query: "" };
  }

  const lastSlash = filter.lastIndexOf("/");
  return {
    currentPath: lastSlash >= 0 ? filter.slice(0, lastSlash + 1) : "./",
    query: lastSlash >= 0 ? filter.slice(lastSlash + 1).toLowerCase() : filter.toLowerCase(),
  };
}
