import type { Terminal } from "@xterm/xterm";
import { computeHostTop, computeScrollAnchor } from "./pty-scroll";
import { appendPtyScrollTrace, isPtyScrollTraceEnabled } from "./pty-scroll-trace";
import { parsePx } from "./pty-style-utils";
import type { PtyVerticalIntentState } from "./pty-vertical-intent-fsm";

interface PtyScrollTraceExtra {
  action?: string;
  reason?: string;
  scope?: string;
  ydisp?: number;
  details?: string;
  cursorDeltaRows?: number | null;
  scrollDeltaToAnchor?: number;
  vvHeightDelta?: number;
  vvOffsetDelta?: number;
}

interface PtyScrollTraceAdapterOptions {
  container: HTMLDivElement;
  host: HTMLDivElement;
  term: Terminal;
  atBottomThreshold: number;
  getDims: () => { cellH: number; cellW: number };
  getVerticalInsets: () => { paddingTop: number; paddingBottom: number };
  getPrevCursorBufferRow: () => number | null;
  getPendingProgrammaticScrollTop: () => number | null;
  getPendingFollowCursorScrollTop: () => number | null;
  getPendingFollowCursorScrollLeft: () => number | null;
  getPendingContainerSyncRetry: () => boolean;
  getHorizontalIntent: () => boolean;
  getVerticalIntent: () => PtyVerticalIntentState;
  getUserHasVerticalScrollIntent: () => boolean;
}

interface PtyScrollTraceAdapter {
  trace: (event: string, extra?: PtyScrollTraceExtra) => void;
  dispose: () => void;
}

export function createPtyScrollTraceAdapter({
  container,
  host,
  term,
  atBottomThreshold,
  getDims,
  getVerticalInsets,
  getPrevCursorBufferRow,
  getPendingProgrammaticScrollTop,
  getPendingFollowCursorScrollTop,
  getPendingFollowCursorScrollLeft,
  getPendingContainerSyncRetry,
  getHorizontalIntent,
  getVerticalIntent,
  getUserHasVerticalScrollIntent,
}: PtyScrollTraceAdapterOptions): PtyScrollTraceAdapter {
  let prevVvHeight: number | null = null;
  let prevVvOffsetTop: number | null = null;

  // focus 字段加细：trace 里能直接看到 data-slot/id/class 摘要，方便定位哪个控件截获了输入。
  const describeFocus = (): string | null => {
    const el = document.activeElement;
    if (!el) return null;
    const aria = el.getAttribute("aria-label") ?? "";
    const tag = el.tagName;
    const slot =
      typeof el.closest === "function"
        ? (el.closest("[data-slot]")?.getAttribute("data-slot") ?? "")
        : "";
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
    const cls =
      typeof el.className === "string" && el.className
        ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : "";
    if (aria) return `${aria}|${tag}${id}${cls}{${slot}}`;
    return `${tag}${id}${cls}{${slot}}`;
  };

  const trace = (event: string, extra: PtyScrollTraceExtra = {}): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const containerRect = container.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const { cellH, cellW } = getDims();
    const { paddingTop, paddingBottom } = getVerticalInsets();
    const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
    const buffer = term.buffer.active;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;
    const anchor = computeScrollAnchor({
      rows: term.rows,
      cellH,
      bufferLength: buffer.length,
      cursorBufferRow,
      visibleContentHeight,
      paddingTop,
      paddingBottom,
      containerScrollTop: container.scrollTop,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      atBottomThreshold,
    });
    const prevCursorBufferRow = getPrevCursorBufferRow();
    const defaultCursorDeltaRows =
      prevCursorBufferRow === null ? null : cursorBufferRow - prevCursorBufferRow;
    const cursorDeltaRows =
      extra.cursorDeltaRows !== undefined ? extra.cursorDeltaRows : defaultCursorDeltaRows;
    const scrollDeltaToAnchor =
      extra.scrollDeltaToAnchor !== undefined
        ? extra.scrollDeltaToAnchor
        : container.scrollTop - anchor.bottomScrollTop;
    const currentHostTop = parsePx(host.style.top);
    const expectedHostTop =
      cellH > 0
        ? computeHostTop({
            ydisp: buffer.viewportY,
            rows: term.rows,
            cellH,
            visibleContentHeight,
          })
        : 0;
    const currentHostHeight = parsePx(host.style.height);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const hostBottom = currentHostTop + currentHostHeight;
    const hostOverlap = Math.max(
      0,
      Math.min(viewportBottom, hostBottom) - Math.max(viewportTop, currentHostTop),
    );
    const verticalIntent = getVerticalIntent();

    appendPtyScrollTrace({
      t: performance.now(),
      event,
      scope: extra.scope,
      action: extra.action,
      reason: extra.reason,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      scrollHeight: container.scrollHeight,
      scrollWidth: container.scrollWidth,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
      innerHeight: window.innerHeight,
      visualViewportHeight: visualViewport?.height,
      visualViewportOffsetTop: visualViewport?.offsetTop,
      containerTop: containerRect.top,
      containerBottom: containerRect.bottom,
      hostRectTop: hostRect.top,
      hostRectBottom: hostRect.bottom,
      viewportY: buffer.viewportY,
      bufferLength: buffer.length,
      hostTop: host.style.top,
      cellH,
      cellW,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      cursorBufferRow,
      cursorDeltaRows,
      cursorInViewport: anchor.cursorInViewport,
      anchorBottomScrollTop: anchor.bottomScrollTop,
      scrollDeltaToAnchor,
      pendingProgrammaticScrollTop: getPendingProgrammaticScrollTop(),
      pendingFollowCursorScrollTop: getPendingFollowCursorScrollTop(),
      pendingFollowCursorScrollLeft: getPendingFollowCursorScrollLeft(),
      pendingContainerSyncRetry: getPendingContainerSyncRetry(),
      horizontalIntent: getHorizontalIntent(),
      intentMode: verticalIntent.mode,
      intentSource: verticalIntent.source,
      intentTransition: verticalIntent.lastTransitionId,
      prevCursorBufferRow,
      hostTopDrift: currentHostTop - expectedHostTop,
      viewportHostCoverage: container.clientHeight > 0 ? hostOverlap / container.clientHeight : 0,
      focus: describeFocus(),
      atBottom: anchor.isAtBottom,
      touchActive: verticalIntent.touchActive,
      userIntent: getUserHasVerticalScrollIntent(),
      ...extra,
    });
  };

  // visualViewport 软键盘 / iOS Safari 地址栏收合 / 缩放只作为诊断事件记录。
  const traceVisualViewport = (event: "vv:resize" | "vv:scroll"): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const dh = prevVvHeight === null ? 0 : vv.height - prevVvHeight;
    const dy = prevVvOffsetTop === null ? 0 : vv.offsetTop - prevVvOffsetTop;
    prevVvHeight = vv.height;
    prevVvOffsetTop = vv.offsetTop;
    trace(event, { vvHeightDelta: dh, vvOffsetDelta: dy });
  };

  const onVvResize = (): void => traceVisualViewport("vv:resize");
  const onVvScroll = (): void => traceVisualViewport("vv:scroll");

  // window 级 wheel sniffer 只诊断 wheel 是否被别的控件截获，不修改 scroll 控制流。
  const onWindowWheelSniff = (event: WheelEvent): void => {
    if (!isPtyScrollTraceEnabled()) return;
    const target = event.target as Element | null;
    const reachesContainer =
      target === container || (target instanceof Node && container.contains(target));
    const targetSlot =
      target && typeof target.closest === "function"
        ? (target.closest("[data-slot]")?.getAttribute("data-slot") ?? "")
        : "";
    const targetTag = target?.tagName ?? "";
    const targetCls =
      target && typeof (target as Element).className === "string" && (target as Element).className
        ? "." +
          ((target as Element).className as string)
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join(".")
        : "";
    trace(
      `wheel:window deltaY=${Math.round(event.deltaY)} reachesContainer=${reachesContainer ? 1 : 0} prevented=${event.defaultPrevented ? 1 : 0} target=${targetTag}${targetCls}{${targetSlot}}`,
    );
  };

  window.visualViewport?.addEventListener("resize", onVvResize);
  window.visualViewport?.addEventListener("scroll", onVvScroll);
  window.addEventListener("wheel", onWindowWheelSniff, { passive: true, capture: true });

  return {
    trace,
    dispose: () => {
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      window.removeEventListener("wheel", onWindowWheelSniff, { capture: true });
    },
  };
}
