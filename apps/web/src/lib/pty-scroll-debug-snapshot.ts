import type { Terminal } from "@xterm/xterm";
import { computePtyHostLayout } from "./pty-scroll";
import { parsePx } from "./pty-style-utils";
import type { PtyDebugSnapshot } from "./pty-debug-snapshot";

// scroll controller 内部读得到、debug snapshot 需要但生产逻辑不需要暴露的瞬态。
// 把这些剥到 probe 里，scroll controller 的生产接口只暴露事件 / 几何 / 滚动控制；
// snapshot 拼装在这个 module 里完成，不把 78 行 debug 逻辑塞到 controller 文件。
export interface PtyScrollDebugProbe {
  cellH: number;
  cellW: number;
  paddingTop: number;
  paddingBottom: number;
  canvasLastY: number;
  userHasVerticalScrollIntent: boolean;
  pendingProgrammaticScrollTop: number | null;
  touchScrollActive: boolean;
  lastSpacerUpdateAt: number | null;
}

export interface PtyScrollDebugRefs {
  container: HTMLElement;
  spacer: HTMLElement;
  host: HTMLElement;
  term: Terminal;
}

export function buildPtyScrollDebugSnapshot(
  getProbe: () => PtyScrollDebugProbe,
  refs: PtyScrollDebugRefs,
): Omit<PtyDebugSnapshot, "frame"> {
  const probe = getProbe();
  const { container, spacer, host, term } = refs;
  const { cellH, cellW, paddingTop, paddingBottom, canvasLastY } = probe;
  const visibleContentHeight = Math.max(0, container.clientHeight - paddingTop - paddingBottom);
  const buffer = term.buffer.active;

  let expectedSpacerHeight = 0;
  if (cellH > 0 && cellW > 0) {
    const layout = computePtyHostLayout(
      {
        bufferLength: buffer.length,
        rows: term.rows,
        cols: term.cols,
        viewportY: buffer.viewportY,
        cellH,
        cellW,
        visibleContentHeight,
      },
      canvasLastY,
    );
    expectedSpacerHeight = layout?.spacerHeight ?? 0;
  }

  const currentSpacerHeight = parsePx(spacer.style.height);
  const currentHostTop = parsePx(host.style.top);
  const currentHostHeight = parsePx(host.style.height);
  const currentHostWidth = parsePx(host.style.width);
  const currentHostPaddingTop = parsePx(host.style.paddingTop);
  const currentSpacerWidth = parsePx(spacer.style.width);

  return {
    ts: performance.now(),
    container: {
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      scrollHeight: container.scrollHeight,
      scrollWidth: container.scrollWidth,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
      paddingTop,
      paddingBottom,
    },
    spacer: { height: currentSpacerHeight, width: currentSpacerWidth },
    host: {
      top: currentHostTop,
      height: currentHostHeight,
      width: currentHostWidth,
      paddingTop: currentHostPaddingTop,
    },
    term: {
      rows: term.rows,
      cols: term.cols,
      bufferLength: buffer.length,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
    },
    cell: { h: cellH, w: cellW },
    visibleContentHeight,
    pinned: !probe.userHasVerticalScrollIntent,
    pendingProgrammaticScrollTop: probe.pendingProgrammaticScrollTop,
    touchScrollActive: probe.touchScrollActive,
    expectedSpacerHeight,
    spacerDrift: currentSpacerHeight - expectedSpacerHeight,
    lastSpacerUpdateAt: probe.lastSpacerUpdateAt,
  };
}
