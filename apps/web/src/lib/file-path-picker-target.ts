export type PickerMode = "insert" | "select";

interface PickerTarget {
  currentPath: string;
  query: string;
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
    const afterAt = filter.split("@").pop() ?? "";
    const windows = remotePathSeparator(options?.baseCwd ?? afterAt) === "\\";
    const lastSlash = Math.max(afterAt.lastIndexOf("/"), windows ? afterAt.lastIndexOf("\\") : -1);
    return {
      currentPath: lastSlash >= 0 ? afterAt.slice(0, lastSlash + 1) : windows ? ".\\" : "./",
      query: afterAt.slice(lastSlash + 1).toLowerCase(),
    };
  }

  const baseCwd = normalizeRemoteAbsolutePath(options?.baseCwd ?? "");
  if (!filter) {
    return { currentPath: withTrailingSeparator(baseCwd), query: "" };
  }

  const normalized = resolveRemotePath(baseCwd, filter);
  if (!normalized) return { currentPath: "", query: "" };
  const parent = remoteParentDirectory(normalized);
  const separator = remotePathSeparator(normalized);
  const isKnownDir =
    filter.endsWith("/") ||
    (separator === "\\" && filter.endsWith("\\")) ||
    normalized === parent ||
    normalized === baseCwd ||
    options?.knownDirs?.has(normalized);
  if (isKnownDir) {
    return { currentPath: withTrailingSeparator(normalized), query: "" };
  }

  return {
    currentPath: withTrailingSeparator(parent),
    query: normalized.slice(normalized.lastIndexOf(separator) + 1).toLowerCase(),
  };
}
import {
  normalizeRemoteAbsolutePath,
  remoteParentDirectory,
  remotePathSeparator,
  resolveRemotePath,
  withTrailingSeparator,
} from "./remote-path";
