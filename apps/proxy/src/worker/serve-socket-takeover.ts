import type { Socket } from "node:net";

// serve 进程快速 stop+start 时，旧 socket 的 close 事件可能还没触发，新 serve 已经连上来。
// session-worker 只允许一条活跃的 serveSocket：到达新连接时显式 destroy 旧的，避免两条
// socket 同时各跑一份 createWorkerReader / pendingApprovals 重发逻辑造成状态不一致。
export function takeoverServeSocket(prev: Socket | null, next: Socket): Socket {
  if (prev && prev !== next) {
    try {
      prev.destroy();
    } catch {
      // 旧 socket 可能已半关闭
    }
  }
  return next;
}
