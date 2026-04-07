import type { SessionBuffer } from "./session-buffer.js";

// streaming 中间消息类型，result 压缩时丢弃
const STREAMING_DELTA_TYPES = new Set([
  "assistant_message",
  "thinking",
]);

// PTY 快照压缩：保留 snapshot 及其后续消息，丢弃 snapshot 之前的所有消息
export function compressOnSnapshot(
  buffer: SessionBuffer,
  snapshotSeq: number,
): void {
  const all = buffer.getAll();
  const snapshotIdx = all.findIndex((m) => m.seq === snapshotSeq);
  if (snapshotIdx <= 0) return;
  buffer.replaceMessages(all.slice(snapshotIdx));
}

// JSON result 压缩：收到 result 事件后丢弃该 turn 的中间 streaming delta
// 保留 user_input、result、tool_use_request、tool_approve、tool_deny、session_* 等
export function compressOnResult(
  buffer: SessionBuffer,
  resultSeq: number,
): void {
  const all = buffer.getAll();
  const resultIdx = all.findIndex((m) => m.seq === resultSeq);
  if (resultIdx < 0) return;

  // 从 result 向前找到最近的 user_input 作为 turn 边界
  let turnStart = 0;
  for (let i = resultIdx - 1; i >= 0; i--) {
    if (all[i].type === "user_input") {
      turnStart = i;
      break;
    }
  }

  // 在 turnStart 到 resultIdx 之间移除 streaming delta 类型
  const filtered = all.filter((m, idx) => {
    if (idx >= turnStart && idx < resultIdx) {
      return !STREAMING_DELTA_TYPES.has(m.type);
    }
    return true;
  });

  buffer.replaceMessages(filtered);
}
