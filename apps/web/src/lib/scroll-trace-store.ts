// 共用的滚动 trace ring buffer + URL/localStorage 开关。
// PTY 和 JSON 视图各有独立的 trace 列与 entry shape，但 enable / append /
// 缓冲淘汰 / 报表数值小工具是相同的；这里集中实现一份避免漂移。

export interface ScrollTraceStoreOptions {
  windowKey: string;
  urlParam: string;
  storageKey: string;
  maxEntries?: number;
}

export interface ScrollTraceStore<T> {
  isEnabled: () => boolean;
  append: (entry: T) => void;
  getAll: () => T[];
}

function getLocalStorageFlag(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function createScrollTraceStore<T>(options: ScrollTraceStoreOptions): ScrollTraceStore<T> {
  const { windowKey, urlParam, storageKey, maxEntries = 500 } = options;

  const isEnabled = (): boolean => {
    if (typeof window === "undefined") return false;
    const hashQueryStart = window.location.hash.indexOf("?");
    const routeParams =
      hashQueryStart >= 0
        ? new URLSearchParams(window.location.hash.slice(hashQueryStart + 1))
        : null;
    const pageParams = new URLSearchParams(window.location.search);
    return (
      pageParams.get(urlParam) === "1" ||
      routeParams?.get(urlParam) === "1" ||
      getLocalStorageFlag(storageKey) === "1"
    );
  };

  const getStore = (): T[] => {
    if (typeof window === "undefined") return [];
    return ((window as unknown as Record<string, T[] | undefined>)[windowKey] ?? []) as T[];
  };

  const setStore = (entries: T[]): void => {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, T[]>)[windowKey] = entries;
  };

  return {
    isEnabled,
    append(entry) {
      if (typeof window === "undefined") return;
      const entries = getStore();
      entries.push(entry);
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
      setStore(entries);
    },
    getAll: getStore,
  };
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function range(values: number[]): string {
  if (values.length === 0) return "";
  return `${round(Math.min(...values))}..${round(Math.max(...values))}`;
}

export function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined).map(round))];
}

export function countDirectionFlips(values: number[]): number {
  let previousDirection = 0;
  let flips = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (Math.abs(delta) < 1) continue;
    const direction = Math.sign(delta);
    if (previousDirection !== 0 && direction !== previousDirection) flips += 1;
    previousDirection = direction;
  }
  return flips;
}
