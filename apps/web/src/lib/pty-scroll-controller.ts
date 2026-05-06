import type { Terminal } from "@xterm/xterm";
import { computePtyHostLayout, computeScrollTarget, ydispToScrollTop } from "./pty-scroll";

interface PtyScrollControllerOptions {
  container: HTMLDivElement;
  spacer: HTMLDivElement;
  host: HTMLDivElement;
  term: Terminal;
  isAtBottom: () => boolean;
  hasNewFrame: () => boolean;
  consumeNewFrame: () => void;
  hasNewFramesWhileAway: () => boolean;
  setNewFramesWhileAway: (value: boolean) => void;
}

export function attachPtyScrollController(options: PtyScrollControllerOptions): () => void {
  const {
    container,
    spacer,
    host,
    term,
    isAtBottom,
    hasNewFrame,
    consumeNewFrame,
    hasNewFramesWhileAway,
    setNewFramesWhileAway,
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
    if (syncing.external) return;
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
  };

  const onTermScroll = (): void => {
    if (syncing.internal) return;
    syncing.external = true;
    try {
      const { cellH } = getDims();
      container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY, cellH);
      applySubpixel(0);
    } finally {
      syncing.external = false;
    }
  };

  const onRender = (): void => {
    updateSpacer();
    if (!hasNewFrame()) return;
    consumeNewFrame();
    if (isAtBottom()) {
      container.scrollTop = container.scrollHeight;
    } else if (!hasNewFramesWhileAway()) {
      setNewFramesWhileAway(true);
    }
  };

  updateSpacer();
  container.scrollTop = container.scrollHeight;

  container.addEventListener("scroll", onContainerScroll, { passive: true });
  const dispScroll = term.onScroll(onTermScroll);
  const dispRender = term.onRender(onRender);
  const ro = new ResizeObserver(updateSpacer);
  ro.observe(container);
  ro.observe(host);

  return () => {
    container.removeEventListener("scroll", onContainerScroll);
    dispScroll.dispose();
    dispRender.dispose();
    ro.disconnect();
  };
}
