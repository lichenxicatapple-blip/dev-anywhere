import type { Socket } from "node:net";

// terminal 进程在 reconnectToServe 成功后用新 socket 替换旧的。无论旧连接已经关闭，
// 还是握手超时后仍半开，都在替换时移除 listener 并销毁，避免连接和引用累积。
export function swapServeSocket(prev: Socket, next: Socket): Socket {
  prev.removeAllListeners();
  prev.destroy();
  return next;
}
