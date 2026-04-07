import type { SessionBuffer } from "./session-buffer.js";

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
