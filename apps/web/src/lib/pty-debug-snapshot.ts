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
    // 取出当前活动 PTY 的 xterm Terminal 实例，便于线上排错时让用户在 console 调用
    // term.refresh(0, term.rows - 1) / term.clearTextureAtlas() 等恢复操作。
    // 类型故意松到 unknown，避免给 web 添加 @xterm/xterm 类型依赖给 globals。
    __devAnywherePtyTerminal?: () => unknown;
  }
}

// 把两个调试入口的 window 写入/清理集中在一处，调用方拿到的 register/unregister 都是幂等的，
// 自身不持状态，由 chat-pty-view 的 effect cleanup 配对调用。
export function registerPtyTerminalWindowAccessor(getTerminal: () => unknown): void {
  window.__devAnywherePtyTerminal = getTerminal;
}

export function unregisterPtyTerminalWindowAccessor(): void {
  if (window.__devAnywherePtyTerminal) delete window.__devAnywherePtyTerminal;
}

export function registerPtyDebugSnapshotProvider(provider: PtyDebugSnapshotProvider): void {
  window.__devAnywherePtyDebug = provider;
}

export function unregisterPtyDebugSnapshotProvider(): void {
  if (window.__devAnywherePtyDebug) delete window.__devAnywherePtyDebug;
}
