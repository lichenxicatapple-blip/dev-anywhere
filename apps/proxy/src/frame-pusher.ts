import type { TerminalFramePayload, RelayControlMessage } from "@cc-anywhere/shared";
import type { TerminalTracker, TermLine, TermSpan } from "./terminal-tracker.js";

// 5fps 推帧频率
export const FRAME_PUSH_INTERVAL_MS = 200;

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

function cloneGrid(grid: TermLine[]): TermLine[] {
  return grid.map((line) => line.map((span) => ({ ...span })));
}

export interface FramePusherOptions {
  tracker: TerminalTracker;
  sessionId: string;
  // 回调接收 terminal_frame Control 消息的 JSON 字符串
  sendFrame: (frameJson: string) => void;
}

export interface FramePusher {
  start(): void;
  stop(): void;
}

/**
 * 创建终端帧推送器
 *
 * 每 200ms 检测 grid 变化，首帧 full 模式，后续 delta 模式只发变化行。
 * terminal.ts 和 replay-e2e.ts 共用此逻辑。
 */
export function createFramePusher(options: FramePusherOptions): FramePusher {
  const { tracker, sessionId, sendFrame } = options;
  let lastGrid: TermLine[] | null = null;
  let interval: NodeJS.Timeout | null = null;

  function push(): void {
    if (!tracker.hasGridChanged()) return;

    const currentGrid = tracker.extractGrid();

    if (lastGrid === null) {
      const payload: TerminalFramePayload = { mode: "full", lines: currentGrid };
      const msg: RelayControlMessage = { type: "terminal_frame", sessionId, payload };
      sendFrame(JSON.stringify(msg));
      lastGrid = cloneGrid(currentGrid);
      return;
    }

    const maxLines = Math.max(currentGrid.length, lastGrid.length);
    const changedLines: Array<{ lineIndex: number; spans: TermSpan[] }> = [];

    for (let i = 0; i < maxLines; i++) {
      const currentLine = currentGrid[i] ?? [];
      const prevLine = lastGrid[i] ?? [];
      if (!linesEqual(currentLine, prevLine)) {
        changedLines.push({ lineIndex: i, spans: currentLine });
      }
    }

    if (changedLines.length === 0) return;

    const payload: TerminalFramePayload = { mode: "delta", lines: changedLines };
    const msg: RelayControlMessage = { type: "terminal_frame", sessionId, payload };
    sendFrame(JSON.stringify(msg));
    lastGrid = cloneGrid(currentGrid);
  }

  return {
    start(): void {
      if (interval) clearInterval(interval);
      lastGrid = null;
      interval = setInterval(push, FRAME_PUSH_INTERVAL_MS);
    },
    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
