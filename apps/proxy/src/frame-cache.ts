// 终端帧缓存：维护每个 session 的完整 grid 状态
// serve 收到 full 帧直接替换，收到 delta 帧 merge 变化行
// terminal_frame_request 时返回合成的 full 帧，客户端刷新不丢画面
import type { TermLine, Cursor } from "@cc-anywhere/shared";

interface CachedGrid {
  lines: TermLine[];
  cursor: Cursor;
}

interface FramePayload {
  mode: "full" | "delta";
  lines: TermLine[] | Array<{ lineIndex: number; spans: TermLine }>;
  cursor: Cursor;
}

export interface FrameCache {
  apply(sessionId: string, payload: FramePayload): void;
  getFullFrame(sessionId: string): string | null;
  remove(sessionId: string): void;
}

export function createFrameCache(): FrameCache {
  const store = new Map<string, CachedGrid>();

  return {
    apply(sessionId: string, payload: FramePayload): void {
      if (payload.mode === "full") {
        store.set(sessionId, {
          lines: payload.lines as TermLine[],
          cursor: payload.cursor,
        });
        return;
      }

      // delta: merge 变化行到已有 grid
      const existing = store.get(sessionId);
      if (!existing) {
        // 没有 full 基底，delta 无法应用，跳过
        return;
      }
      const deltas = payload.lines as Array<{ lineIndex: number; spans: TermLine }>;
      for (const { lineIndex, spans } of deltas) {
        while (existing.lines.length <= lineIndex) {
          existing.lines.push([]);
        }
        existing.lines[lineIndex] = spans;
      }
      existing.cursor = payload.cursor;
    },

    getFullFrame(sessionId: string): string | null {
      const cached = store.get(sessionId);
      if (!cached) return null;
      return JSON.stringify({
        type: "terminal_frame",
        sessionId,
        payload: { mode: "full", lines: cached.lines, cursor: cached.cursor },
      });
    },

    remove(sessionId: string): void {
      store.delete(sessionId);
    },
  };
}
