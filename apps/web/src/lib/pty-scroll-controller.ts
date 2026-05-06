import type { Terminal } from "@xterm/xterm";
import { computePtyHostLayout, computeScrollTarget, ydispToScrollTop } from "./pty-scroll";

interface PtyScrollControllerOptions {
  container: HTMLDivElement;
  spacer: HTMLDivElement;
  host: HTMLDivElement;
  term: Terminal;
  hasNewFrame: () => boolean;
  consumeNewFrame: () => void;
  hasNewFramesWhileAway: () => boolean;
  setNewFramesWhileAway: (value: boolean) => void;
  onAtBottomChange?: (value: boolean) => void;
  onScrollStateChange?: (state: PtyScrollState) => void;
  atBottomThreshold?: number;
}

interface PtyScrollController {
  dispose: () => void;
  relayout: () => void;
  scrollToBottom: () => void;
  scrollToRatio: (ratio: number) => void;
}

export interface PtyScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollable: boolean;
}

export function attachPtyScrollController(
  options: PtyScrollControllerOptions,
): PtyScrollController {
  const {
    container,
    spacer,
    host,
    term,
    hasNewFrame,
    consumeNewFrame,
    hasNewFramesWhileAway,
    setNewFramesWhileAway,
    onAtBottomChange,
    onScrollStateChange,
    atBottomThreshold = 8,
  } = options;

  const getDims = (): { cellH: number; cellW: number } => {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || term.rows === 0 || term.cols === 0) return { cellH: 0, cellW: 0 };
    return {
      cellH: screen.clientHeight / term.rows,
      cellW: screen.clientWidth / term.cols,
    };
  };

  const syncing = { external: false, internal: false };
  let lastAtBottom: boolean | null = null;
  let lastScrollStateKey = "";

  const getScrollState = (): PtyScrollState => ({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    scrollable: container.scrollHeight > container.clientHeight + atBottomThreshold,
  });

  const notifyScrollState = (): void => {
    if (!onScrollStateChange) return;
    const state = getScrollState();
    const key = `${state.scrollTop}:${state.scrollHeight}:${state.clientHeight}:${state.scrollable}`;
    if (key === lastScrollStateKey) return;
    lastScrollStateKey = key;
    onScrollStateChange(state);
  };

  const computeIsAtBottom = (): boolean =>
    container.scrollTop + container.clientHeight >= container.scrollHeight - atBottomThreshold;

  const notifyAtBottom = (): void => {
    const next = computeIsAtBottom();
    if (lastAtBottom === next) return;
    lastAtBottom = next;
    onAtBottomChange?.(next);
  };

  const notifyScroll = (): void => {
    notifyAtBottom();
    notifyScrollState();
  };

  const scrollToBottom = (): void => {
    container.scrollTop = container.scrollHeight;
    notifyScroll();
  };

  const scrollToRatio = (ratio: number): void => {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(1, ratio));
    container.scrollTop = maxScrollTop * clamped;
    onContainerScroll();
  };

  const applySubpixel = (px: number): void => {
    const xtermRoot = host.querySelector<HTMLElement>(".xterm");
    if (!xtermRoot) return;
    xtermRoot.style.transform = px !== 0 ? `translate3d(0,${-px}px,0)` : "";
  };

  const updateSpacer = (): void => {
    const { cellH, cellW } = getDims();
    if (cellH === 0 || cellW === 0) return;
    const buffer = term.buffer.active;
    let canvasLastY = -1;
    for (let ry = term.rows - 1; ry >= 0; ry--) {
      const absY = buffer.viewportY + ry;
      if (absY < 0 || absY >= buffer.length) continue;
      const line = buffer.getLine(absY);
      if (line && line.translateToString(true).trimEnd().length > 0) {
        canvasLastY = ry;
        break;
      }
    }
    const layout = computePtyHostLayout(
      {
        bufferLength: buffer.length,
        rows: term.rows,
        cols: term.cols,
        viewportY: buffer.viewportY,
        cellH,
        cellW,
      },
      canvasLastY,
    );
    if (!layout) return;
    spacer.style.height = `${layout.spacerHeight}px`;
    spacer.style.width = `${layout.spacerWidth}px`;
    host.style.width = `${layout.hostWidth}px`;
    host.style.height = `${layout.hostHeight}px`;
    host.style.paddingTop = `${layout.hostPaddingTop}px`;
  };

  const scrollToYdisp = (ydisp: number): void => {
    syncing.internal = true;
    try {
      term.scrollToLine(ydisp);
    } finally {
      syncing.internal = false;
    }
  };

  const onContainerScroll = (): void => {
    if (syncing.external) {
      notifyScroll();
      return;
    }
    const { cellH } = getDims();
    if (cellH === 0) return;
    const buffer = term.buffer.active;
    const { ydisp, subpixel } = computeScrollTarget(container.scrollTop, {
      bufferLength: buffer.length,
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
      cellH,
      cellW: 1,
    });
    applySubpixel(subpixel);
    if (ydisp !== buffer.viewportY) {
      scrollToYdisp(ydisp);
    }
    notifyScroll();
  };

  const onTermScroll = (): void => {
    if (syncing.internal) return;
    const wasAtBottom = computeIsAtBottom();
    syncing.external = true;
    try {
      updateSpacer();
      if (wasAtBottom) {
        scrollToBottom();
        return;
      }
      const { cellH } = getDims();
      container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
      applySubpixel(0);
      notifyScroll();
    } finally {
      syncing.external = false;
    }
  };

  const relayout = (): void => {
    const wasAtBottom = computeIsAtBottom();
    updateSpacer();
    if (wasAtBottom) {
      scrollToBottom();
      return;
    }

    const { cellH } = getDims();
    if (cellH !== 0) {
      container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
      applySubpixel(0);
    }
    notifyScroll();
  };

  const onRender = (): void => {
    const wasAtBottom = computeIsAtBottom();
    updateSpacer();
    if (!hasNewFrame()) return;
    consumeNewFrame();
    if (wasAtBottom) {
      scrollToBottom();
    } else if (!hasNewFramesWhileAway()) {
      setNewFramesWhileAway(true);
    }
    notifyScroll();
  };

  updateSpacer();
  scrollToBottom();

  container.addEventListener("scroll", onContainerScroll, { passive: true });
  const dispScroll = term.onScroll(onTermScroll);
  const dispRender = term.onRender(onRender);
  const ro = new ResizeObserver(relayout);
  ro.observe(container);
  ro.observe(host);

  return {
    dispose: () => {
      container.removeEventListener("scroll", onContainerScroll);
      dispScroll.dispose();
      dispRender.dispose();
      ro.disconnect();
    },
    relayout,
    scrollToBottom,
    scrollToRatio,
  };
}
