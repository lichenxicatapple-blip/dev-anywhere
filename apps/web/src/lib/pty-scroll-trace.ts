import {
  countDirectionFlips,
  createScrollTraceStore,
  range,
  round,
  uniqueNumbers,
} from "./scroll-trace-store";
import { parsePx } from "./pty-style-utils";

interface PtyScrollTraceEntry {
  t: number;
  event: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  innerHeight?: number;
  visualViewportHeight?: number;
  visualViewportOffsetTop?: number;
  containerTop?: number;
  containerBottom?: number;
  hostRectTop?: number;
  hostRectBottom?: number;
  viewportY: number;
  bufferLength: number;
  hostTop: string;
  focus: string | null;
  atBottom?: boolean;
  touchActive?: boolean;
  userIntent?: boolean;
  ydisp?: number;
}

declare global {
  interface Window {
    __devAnywherePtyScrollTrace?: PtyScrollTraceEntry[];
  }
}

const store = createScrollTraceStore<PtyScrollTraceEntry>({
  windowKey: "__devAnywherePtyScrollTrace",
  urlParam: "ptyScrollTrace",
  storageKey: "dev_anywhere_pty_scroll_trace",
});

export const isPtyScrollTraceEnabled = store.isEnabled;
export const appendPtyScrollTrace = store.append;

export function formatPtyScrollTraceReport(): string {
  const trace = store.getAll();
  const rows = trace.slice(-160);
  const scrollValues = rows.map((entry) => entry.scrollTop);
  const viewportValues = rows.map((entry) => entry.viewportY);
  const clientHeights = uniqueNumbers(rows.map((entry) => entry.clientHeight));
  const visualHeights = uniqueNumbers(rows.map((entry) => entry.visualViewportHeight));
  const focusValues = [...new Set(rows.map((entry) => entry.focus ?? "null"))].join(",");
  const flips = countDirectionFlips(scrollValues);
  const lines = rows.map((entry) =>
    [
      round(entry.t),
      entry.event,
      round(entry.scrollTop),
      entry.viewportY,
      entry.hostTop,
      round(entry.scrollTop - parsePx(entry.hostTop)),
      entry.clientHeight,
      entry.visualViewportHeight === undefined ? "" : round(entry.visualViewportHeight),
      entry.visualViewportOffsetTop === undefined ? "" : round(entry.visualViewportOffsetTop),
      entry.atBottom ? "bottom" : "",
      entry.touchActive ? "touch" : "",
      entry.userIntent ? "intent" : "",
      entry.focus ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere PTY scroll trace",
    `events=${trace.length}, included=${rows.length}`,
    `scrollTop=${range(scrollValues)}, viewportY=${range(viewportValues)}, directionFlips=${flips}`,
    `clientHeight=${clientHeights.join(",")}, visualViewportHeight=${visualHeights.join(",")}`,
    `focus=${focusValues}`,
    "t\tevent\tscrollTop\tviewportY\thostTop\tscrollMinusHost\tclientHeight\tvvHeight\tvvTop\tatBottom\ttouch\tintent\tfocus",
    ...lines,
  ].join("\n");
}
