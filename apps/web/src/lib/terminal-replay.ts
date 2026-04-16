// 终端状态恢复和事件回放
// fixture 回放和 Phase 11 客户端重连共用此模块
import type { Terminal } from "@xterm/xterm";

export type ReplayChunk =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "meta"; cols: number; rows: number }
  | { type: "snapshot"; cols: number; rows: number; data: string };

// 将 snapshot 的序列化内容写入 terminal，恢复到快照时刻的完整视觉状态
export function applySnapshot(
  terminal: Terminal,
  snapshot: { cols: number; rows: number; data: string },
): void {
  terminal.resize(snapshot.cols, snapshot.rows);
  terminal.write(snapshot.data);
}

// 从 chunks 中找到最后一个 snapshot 的索引，作为回放起点
export function findReplayStart(chunks: ReplayChunk[]): number {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].type === "snapshot") return i;
  }
  return 0;
}

// 从指定位置开始回放 chunks 到 terminal
export function replayChunks(
  terminal: Terminal,
  chunks: ReplayChunk[],
  startIndex = 0,
): void {
  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i];
    switch (chunk.type) {
      case "snapshot":
        applySnapshot(terminal, chunk);
        break;
      case "meta":
      case "resize":
        terminal.resize(chunk.cols, chunk.rows);
        break;
      case "data": {
        const bytes = Uint8Array.from(atob(chunk.data), (c) =>
          c.charCodeAt(0),
        );
        terminal.write(bytes);
        break;
      }
    }
  }
}
