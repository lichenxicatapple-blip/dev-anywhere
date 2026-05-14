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
  vvHeightDelta?: number;
  vvOffsetDelta?: number;
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
  // 自由格式补充信息: hostTop delta / cursor row / followCursor 判定路径 / scroll-to-bottom 命中状态等。
  details?: string;
  // 连续 dedupe key 命中次数 (store 维护)。
  repeat?: number;
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
  // 稳态噪音去重: 高频 render / host-position / scroll-to-bottom-no-op 等连续相同状态折叠。
  // 用户输入 (wheel / intent / touch) 与 visualViewport / followCursor 等关键诊断信号保持独立。
  dedupeKey: (entry) => {
    if (
      entry.event.startsWith("wheel") ||
      entry.event.startsWith("intent:") ||
      entry.event.startsWith("touch") ||
      entry.event.startsWith("vv:") ||
      entry.event.startsWith("followCursor:hit") ||
      entry.event === "container-scroll" ||
      entry.event === "term-scroll" ||
      entry.event === "pending-sync-retry-fire" ||
      entry.event === "scroll-to-ratio:start"
    ) {
      return null;
    }
    return `${entry.event}|${Math.round(entry.scrollTop)}|${entry.viewportY}|${entry.hostTop}`;
  },
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
      entry.repeat && entry.repeat > 0 ? `${entry.event} +${entry.repeat}` : entry.event,
      round(entry.scrollTop),
      round(entry.scrollHeight),
      entry.viewportY,
      entry.ydisp ?? "",
      entry.hostTop,
      round(entry.scrollTop - parsePx(entry.hostTop)),
      entry.clientHeight,
      entry.visualViewportHeight === undefined ? "" : round(entry.visualViewportHeight),
      entry.visualViewportOffsetTop === undefined ? "" : round(entry.visualViewportOffsetTop),
      entry.vvHeightDelta === undefined ? "" : round(entry.vvHeightDelta),
      entry.vvOffsetDelta === undefined ? "" : round(entry.vvOffsetDelta),
      entry.atBottom ? "bottom" : "",
      entry.touchActive ? "touch" : "",
      entry.userIntent ? "intent" : "",
      entry.details ?? "",
      entry.focus ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere PTY scroll trace",
    `events=${trace.length}, included=${rows.length}`,
    `scrollTop=${range(scrollValues)}, viewportY=${range(viewportValues)}, directionFlips=${flips}`,
    `clientHeight=${clientHeights.join(",")}, visualViewportHeight=${visualHeights.join(",")}`,
    `focus=${focusValues}`,
    "t\tevent\tscrollTop\tscrollHeight\tviewportY\tydisp\thostTop\tscrollMinusHost\tclientHeight\tvvHeight\tvvTop\tvvHDelta\tvvODelta\tatBottom\ttouch\tintent\tdetails\tfocus",
    ...lines,
  ].join("\n");
}
