// 共用的滚动 trace ring buffer + URL/localStorage 开关。
// PTY 和 JSON 视图各有独立的 trace 列与 entry shape，但 enable / append /
// 缓冲淘汰 / 报表数值小工具是相同的；这里集中实现一份避免漂移。

interface ScrollTraceStoreOptions<T> {
  windowKey: string;
  urlParam: string;
  storageKey: string;
  maxEntries?: number;
  // 稳态去重: 返回相同 key 的连续 entry 折叠成单行 + repeat 计数, 旧 entry 的 t 更新成最新一次。
  // 返回 null 表示该条不参与去重 (用户输入 / 状态变化事件保持独立行)。
  dedupeKey?: (entry: T) => string | null;
}

interface ScrollTraceEntryBase {
  t: number;
  event: string;
  // append 自动维护: 连续相同 dedupeKey 命中次数 (首条 = 0, 第二条命中 = 1, ...)。
  repeat?: number;
}

interface ScrollTraceStore<T> {
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

export function createScrollTraceStore<T extends ScrollTraceEntryBase>(
  options: ScrollTraceStoreOptions<T>,
): ScrollTraceStore<T> {
  const { windowKey, urlParam, storageKey, maxEntries = 5000, dedupeKey } = options;

  // URL flag 命中后落一次 localStorage，路由切换 (HashRouter 改 hash 会丢 query)
  // 后 isEnabled() 仍能从 localStorage 读到 enabled 状态。
  const persistEnabled = (): void => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage?.setItem(storageKey, "1");
    } catch {
      // ignore storage failures
    }
  };

  const isEnabled = (): boolean => {
    if (typeof window === "undefined") return false;
    const hashQueryStart = window.location.hash.indexOf("?");
    const routeParams =
      hashQueryStart >= 0
        ? new URLSearchParams(window.location.hash.slice(hashQueryStart + 1))
        : null;
    const pageParams = new URLSearchParams(window.location.search);
    if (pageParams.get(urlParam) === "1" || routeParams?.get(urlParam) === "1") {
      persistEnabled();
      return true;
    }
    return getLocalStorageFlag(storageKey) === "1";
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
      const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
      if (last && dedupeKey) {
        const incomingKey = dedupeKey(entry);
        const lastKey = dedupeKey(last);
        if (incomingKey !== null && lastKey !== null && incomingKey === lastKey) {
          last.t = entry.t;
          last.repeat = (last.repeat ?? 0) + 1;
          setStore(entries);
          return;
        }
      }
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
