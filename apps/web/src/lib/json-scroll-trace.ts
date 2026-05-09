interface JsonScrollTraceEntry {
  t: number;
  event: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  innerHeight?: number;
  visualViewportHeight?: number;
  visualViewportOffsetTop?: number;
  messageCount: number;
  totalSize: number;
  firstIndex?: number;
  lastIndex?: number;
  firstStart?: number;
  lastEnd?: number;
  focus: string | null;
  atBottom?: boolean;
  historyLoading?: boolean;
  historyHasMore?: boolean;
  preservePrepend?: boolean;
  scrollDelta?: number;
  scrollHeightDelta?: number;
}

declare global {
  interface Window {
    __devAnywhereJsonScrollTrace?: JsonScrollTraceEntry[];
  }
}

export function isJsonScrollTraceEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const hashQueryStart = window.location.hash.indexOf("?");
  const routeParams =
    hashQueryStart >= 0
      ? new URLSearchParams(window.location.hash.slice(hashQueryStart + 1))
      : null;
  const pageParams = new URLSearchParams(window.location.search);
  return (
    pageParams.get("jsonScrollTrace") === "1" ||
    routeParams?.get("jsonScrollTrace") === "1" ||
    getLocalStorageFlag("dev_anywhere_json_scroll_trace") === "1"
  );
}

function getLocalStorageFlag(key: string): string | null {
  try {
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function appendJsonScrollTrace(entry: JsonScrollTraceEntry): void {
  if (typeof window === "undefined") return;
  const trace = window.__devAnywhereJsonScrollTrace ?? [];
  trace.push(entry);
  if (trace.length > 500) trace.splice(0, trace.length - 500);
  window.__devAnywhereJsonScrollTrace = trace;
}

export function formatJsonScrollTraceReport(): string {
  const trace = window.__devAnywhereJsonScrollTrace ?? [];
  const rows = trace.slice(-180);
  const scrollValues = rows.map((entry) => entry.scrollTop);
  const totalSizeValues = rows.map((entry) => entry.totalSize);
  const clientHeights = uniqueNumbers(rows.map((entry) => entry.clientHeight));
  const visualHeights = uniqueNumbers(rows.map((entry) => entry.visualViewportHeight));
  const focusValues = [...new Set(rows.map((entry) => entry.focus ?? "null"))].join(",");
  const flips = countDirectionFlips(scrollValues);
  const lines = rows.map((entry) =>
    [
      round(entry.t),
      entry.event,
      round(entry.scrollTop),
      entry.scrollHeight,
      entry.clientHeight,
      entry.messageCount,
      round(entry.totalSize),
      indexRange(entry.firstIndex, entry.lastIndex),
      entry.firstStart === undefined ? "" : round(entry.firstStart),
      entry.lastEnd === undefined ? "" : round(entry.lastEnd),
      entry.visualViewportHeight === undefined ? "" : round(entry.visualViewportHeight),
      entry.atBottom ? "bottom" : "",
      entry.historyLoading || entry.historyHasMore ? historyFlag(entry) : "",
      entry.preservePrepend ? "preserve" : "",
      entry.scrollDelta === undefined ? "" : round(entry.scrollDelta),
      entry.scrollHeightDelta === undefined ? "" : round(entry.scrollHeightDelta),
      entry.focus ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere JSON scroll trace",
    `events=${trace.length}, included=${rows.length}`,
    `scrollTop=${range(scrollValues)}, totalSize=${range(totalSizeValues)}, directionFlips=${flips}`,
    `clientHeight=${clientHeights.join(",")}, visualViewportHeight=${visualHeights.join(",")}`,
    `focus=${focusValues}`,
    "t\tevent\tscrollTop\tscrollHeight\tclientHeight\tmessages\ttotalSize\tvisible\tfirstStart\tlastEnd\tvvHeight\tatBottom\thistory\tpreserve\tscrollDelta\tscrollHeightDelta\tfocus",
    ...lines,
  ].join("\n");
}

function historyFlag(entry: JsonScrollTraceEntry): string {
  if (entry.historyLoading && entry.historyHasMore) return "loading+more";
  if (entry.historyLoading) return "loading";
  if (entry.historyHasMore) return "more";
  return "";
}

function indexRange(first?: number, last?: number): string {
  if (first === undefined || last === undefined) return "";
  return `${first}..${last}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function range(values: number[]): string {
  if (values.length === 0) return "";
  return `${round(Math.min(...values))}..${round(Math.max(...values))}`;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined).map(round))];
}

function countDirectionFlips(values: number[]): number {
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
