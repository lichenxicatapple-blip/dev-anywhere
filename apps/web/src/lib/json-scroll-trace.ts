import {
  countDirectionFlips,
  createScrollTraceStore,
  range,
  round,
  uniqueNumbers,
} from "./scroll-trace-store";

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

const store = createScrollTraceStore<JsonScrollTraceEntry>({
  windowKey: "__devAnywhereJsonScrollTrace",
  urlParam: "jsonScrollTrace",
  storageKey: "dev_anywhere_json_scroll_trace",
});

export const isJsonScrollTraceEnabled = store.isEnabled;
export const appendJsonScrollTrace = store.append;

export function formatJsonScrollTraceReport(): string {
  const trace = store.getAll();
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
