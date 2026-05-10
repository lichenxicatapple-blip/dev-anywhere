// PTY 视图的几何 / 滚动 / xterm 状态点对点快照。
// 通过 window.__devAnywherePtyDebug() 暴露给 console，不参与运行时逻辑。
export interface PtyDebugSnapshot {
  ts: number;
  container: {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
    paddingTop: number;
    paddingBottom: number;
  };
  spacer: { height: number; width: number };
  host: { top: number; height: number; width: number; paddingTop: number };
  term: {
    rows: number;
    cols: number;
    bufferLength: number;
    viewportY: number;
    baseY: number;
    cursorX: number;
    cursorY: number;
  };
  cell: { h: number; w: number };
  visibleContentHeight: number;
  pinned: boolean;
  pendingProgrammaticScrollTop: number | null;
  touchScrollActive: boolean;
  // 用当前 buffer / cell 重新跑一次 computePtyHostLayout 得到的 spacer 期望高度，
  // 与 spacer.height 一起暴露便于检测漂移（updateSpacer 与渲染之间任意 race 的标志）。
  expectedSpacerHeight: number;
  spacerDrift: number;
  lastSpacerUpdateAt: number | null;
  frame: {
    lastWriteAt: number | null;
    pendingNewFrame: boolean;
  };
}

export type PtyDebugSnapshotProvider = () => PtyDebugSnapshot | null;

declare global {
  interface Window {
    __devAnywherePtyDebug?: PtyDebugSnapshotProvider;
  }
}
