import type { Socket } from "node:net";

// terminal 进程在 reconnectToServe 成功后用新 socket 替换旧的。旧 socket 已被 close 事件
// 触发过，但 createIpcReader 内部 pipe 的 LineBuffer + 在原 socket 上注册的 close/error/data
// listener 仍持有引用；不显式 removeAllListeners 会让它们随着每次 reconnect 单调累积，
// 长跑（夜间 / 网络抖动频繁）下成为内存泄漏。
export function swapServeSocket(prev: Socket, next: Socket): Socket {
  prev.removeAllListeners();
  return next;
}
