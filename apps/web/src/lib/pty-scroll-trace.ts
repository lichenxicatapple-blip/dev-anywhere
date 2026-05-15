import {
  countDirectionFlips,
  createScrollTraceStore,
  range,
  round,
  uniqueNumbers,
} from "./scroll-trace-store";
import { parsePx } from "./pty-style-utils";

export interface PtyScrollTraceEntry {
  t: number;
  event: string;
  scope?: string;
  action?: string;
  reason?: string;
  scrollTop: number;
  scrollLeft?: number;
  scrollHeight: number;
  scrollWidth?: number;
  clientHeight: number;
  clientWidth?: number;
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
  cellH?: number;
  cellW?: number;
  cursorX?: number;
  cursorY?: number;
  cursorBufferRow?: number;
  cursorInViewport?: boolean;
  anchorBottomScrollTop?: number;
  pendingProgrammaticScrollTop?: number | null;
  pendingFollowCursorScrollTop?: number | null;
  pendingFollowCursorScrollLeft?: number | null;
  pendingContainerSyncRetry?: boolean;
  horizontalIntent?: boolean;
  prevCursorBufferRow?: number | null;
  hostTopDrift?: number;
  viewportHostCoverage?: number;
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

function normalizePtyScrollEvent(
  event: string,
): Pick<PtyScrollTraceEntry, "scope" | "action" | "reason"> {
  const bracket = event.match(/^(.+?)\[(.+)\]$/);
  const base = bracket?.[1] ?? event;
  const reason = bracket?.[2];
  const separator = base.indexOf(":");
  if (separator >= 0) {
    return {
      scope: base.slice(0, separator),
      action: base.slice(separator + 1),
      reason,
    };
  }
  return { scope: base, action: "", reason };
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
      entry.event.startsWith("horizontal-intent:") ||
      entry.event.startsWith("touch") ||
      entry.event.startsWith("vv:") ||
      (entry.event.startsWith("followCursor") && entry.event.includes(":hit")) ||
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

export function appendPtyScrollTrace(entry: PtyScrollTraceEntry): void {
  const normalized = normalizePtyScrollEvent(entry.event);
  store.append({
    ...entry,
    scope: entry.scope ?? normalized.scope,
    action: entry.action ?? normalized.action,
    reason: entry.reason ?? normalized.reason,
  });
}

export function formatPtyScrollTraceReport(): string {
  const trace = store.getAll();
  const rows = trace.slice(-160);
  const debugSnapshot =
    (
      window as typeof window & {
        __devAnywherePtyDebug?: () => unknown;
      }
    ).__devAnywherePtyDebug?.() ?? null;
  const scrollValues = rows.map((entry) => entry.scrollTop);
  const viewportValues = rows.map((entry) => entry.viewportY);
  const clientHeights = uniqueNumbers(rows.map((entry) => entry.clientHeight));
  const visualHeights = uniqueNumbers(rows.map((entry) => entry.visualViewportHeight));
  const focusValues = [...new Set(rows.map((entry) => entry.focus ?? "null"))].join(",");
  const flips = countDirectionFlips(scrollValues);
  const hostTopDrifts = uniqueNumbers(rows.map((entry) => entry.hostTopDrift));
  const hostCoverages = uniqueNumbers(rows.map((entry) => entry.viewportHostCoverage));
  const pendingSyncRetries = rows.filter((entry) => entry.pendingContainerSyncRetry).length;
  const horizontalIntentSamples = rows.filter((entry) => entry.horizontalIntent).length;
  const lines = rows.map((entry) =>
    [
      round(entry.t),
      entry.repeat && entry.repeat > 0 ? `${entry.event} +${entry.repeat}` : entry.event,
      entry.scope ?? "",
      entry.action ?? "",
      entry.reason ?? "",
      round(entry.scrollTop),
      entry.scrollLeft === undefined ? "" : round(entry.scrollLeft),
      round(entry.scrollHeight),
      entry.scrollWidth === undefined ? "" : round(entry.scrollWidth),
      entry.viewportY,
      entry.ydisp ?? "",
      entry.hostTop,
      round(entry.scrollTop - parsePx(entry.hostTop)),
      entry.hostTopDrift === undefined ? "" : round(entry.hostTopDrift),
      entry.viewportHostCoverage === undefined ? "" : round(entry.viewportHostCoverage),
      entry.clientHeight,
      entry.clientWidth === undefined ? "" : round(entry.clientWidth),
      entry.cellH === undefined ? "" : round(entry.cellH),
      entry.cellW === undefined ? "" : round(entry.cellW),
      entry.cursorX ?? "",
      entry.cursorY ?? "",
      entry.cursorBufferRow ?? "",
      entry.cursorInViewport ? "cursorY" : "",
      entry.anchorBottomScrollTop === undefined ? "" : round(entry.anchorBottomScrollTop),
      entry.visualViewportHeight === undefined ? "" : round(entry.visualViewportHeight),
      entry.visualViewportOffsetTop === undefined ? "" : round(entry.visualViewportOffsetTop),
      entry.vvHeightDelta === undefined ? "" : round(entry.vvHeightDelta),
      entry.vvOffsetDelta === undefined ? "" : round(entry.vvOffsetDelta),
      entry.atBottom ? "bottom" : "",
      entry.touchActive ? "touch" : "",
      entry.userIntent ? "intent" : "",
      entry.horizontalIntent ? "hIntent" : "",
      entry.pendingContainerSyncRetry ? "syncRetry" : "",
      entry.pendingProgrammaticScrollTop ?? "",
      entry.pendingFollowCursorScrollTop ?? "",
      entry.pendingFollowCursorScrollLeft ?? "",
      entry.prevCursorBufferRow ?? "",
      entry.details ?? "",
      entry.focus ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere PTY scroll trace",
    `events=${trace.length}, included=${rows.length}`,
    `scrollTop=${range(scrollValues)}, viewportY=${range(viewportValues)}, directionFlips=${flips}`,
    `clientHeight=${clientHeights.join(",")}, visualViewportHeight=${visualHeights.join(",")}`,
    `hostTopDrift=${range(hostTopDrifts)}, viewportHostCoverage=${range(hostCoverages)}`,
    `horizontalIntentSamples=${horizontalIntentSamples}, pendingSyncRetrySamples=${pendingSyncRetries}`,
    `focus=${focusValues}`,
    "debugSnapshot=",
    JSON.stringify(debugSnapshot, null, 2),
    "t\tevent\tscope\taction\treason\tscrollTop\tscrollLeft\tscrollHeight\tscrollWidth\tviewportY\tydisp\thostTop\tscrollMinusHost\thostTopDrift\tviewportHostCoverage\tclientHeight\tclientWidth\tcellH\tcellW\tcursorX\tcursorY\tcursorBufferRow\tcursorInViewport\tanchorBottomScrollTop\tvvHeight\tvvTop\tvvHDelta\tvvODelta\tatBottom\ttouch\tintent\thIntent\tpendingSyncRetry\tpendingProgrammaticY\tpendingFollowY\tpendingFollowX\tprevCursorBufferRow\tdetails\tfocus",
    ...lines,
  ].join("\n");
}
