import type { Logger } from "pino";
import type { TerminalTracker, TermLine, TermSpan } from "../terminal-tracker.js";

// 5fps 推送频率
export const FRAME_PUSH_INTERVAL_MS = 200;

// 增量终端帧推送的单行变更描述
interface DeltaLine {
  lineIndex: number;
  spans: TermSpan[];
}

export interface TerminalPushHandler {
  start(sessionId: string, tracker: TerminalTracker): void;
  stop(sessionId: string): void;
  stopAll(): void;
}

// 每个 session 的推送状态
interface SessionPushState {
  tracker: TerminalTracker;
  lastGrid: TermLine[] | null;
  interval: NodeJS.Timeout;
}

// 比较两行是否相同
function linesEqual(a: TermSpan[], b: TermSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text) return false;
    if (a[i].fg !== b[i].fg) return false;
    if (a[i].bg !== b[i].bg) return false;
    if (a[i].bold !== b[i].bold) return false;
  }
  return true;
}

// 深拷贝网格，避免引用共享导致比较失效
function cloneGrid(grid: TermLine[]): TermLine[] {
  return grid.map((line) =>
    line.map((span) => ({ ...span })),
  );
}

export function createTerminalPushHandler(
  send: (data: string) => void,
  logger: Logger,
): TerminalPushHandler {
  const sessions = new Map<string, SessionPushState>();

  function pushFrame(sessionId: string, state: SessionPushState): void {
    if (!state.tracker.hasGridChanged()) return;

    const currentGrid = state.tracker.extractGrid();

    if (state.lastGrid === null) {
      // 首帧发送全量，Control 格式无 seq
      const msg = {
        type: "terminal_frame",
        sessionId,
        payload: {
          mode: "full",
          lines: currentGrid,
        },
      };
      send(JSON.stringify(msg));
      state.lastGrid = cloneGrid(currentGrid);
      logger.debug({ sessionId, mode: "full", lineCount: currentGrid.length }, "Terminal frame pushed (full)");
      return;
    }

    // 增量模式：逐行比较，只发送变化的行
    const maxLines = Math.max(currentGrid.length, state.lastGrid.length);
    const changedLines: DeltaLine[] = [];

    for (let i = 0; i < maxLines; i++) {
      const currentLine = currentGrid[i] ?? [];
      const lastLine = state.lastGrid[i] ?? [];

      if (!linesEqual(currentLine, lastLine)) {
        changedLines.push({ lineIndex: i, spans: currentLine });
      }
    }

    if (changedLines.length === 0) return;

    const msg = {
      type: "terminal_frame",
      sessionId,
      payload: {
        mode: "delta",
        lines: changedLines,
      },
    };
    send(JSON.stringify(msg));
    state.lastGrid = cloneGrid(currentGrid);
    logger.debug({ sessionId, mode: "delta", changedLines: changedLines.length }, "Terminal frame pushed (delta)");
  }

  return {
    start(sessionId: string, tracker: TerminalTracker): void {
      // 已有 session 先停止再重启
      const existing = sessions.get(sessionId);
      if (existing) {
        clearInterval(existing.interval);
      }

      const state: SessionPushState = {
        tracker,
        lastGrid: null,
        interval: null as unknown as NodeJS.Timeout,
      };

      state.interval = setInterval(() => pushFrame(sessionId, state), FRAME_PUSH_INTERVAL_MS);
      sessions.set(sessionId, state);
      logger.info({ sessionId }, "Terminal push started");
    },

    stop(sessionId: string): void {
      const state = sessions.get(sessionId);
      if (state) {
        clearInterval(state.interval);
        sessions.delete(sessionId);
        logger.info({ sessionId }, "Terminal push stopped");
      }
    },

    stopAll(): void {
      for (const [sessionId, state] of sessions) {
        clearInterval(state.interval);
        logger.info({ sessionId }, "Terminal push stopped (stopAll)");
      }
      sessions.clear();
    },
  };
}
