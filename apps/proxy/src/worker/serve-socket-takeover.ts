import type { Socket } from "node:net";
import { createWorkerReader, type WorkerMessage } from "../ipc/ipc-protocol.js";

/** Read the client's existing hello before exposing worker state or replacing an active daemon.
 * Windows' default pipe ACL permits other users to read, but not write: a silent reader must
 * never receive a hello, queued output or the right to take over a working connection. */
export function readServeConnection(
  socket: Socket,
  sessionId: string,
  callbacks: {
    onAccepted: () => void;
    onMessage: (message: WorkerMessage) => void;
    onError: (error: Error) => void;
  },
  timeoutMs = 5_000,
): void {
  let accepted = false;
  const timeout = setTimeout(() => socket.destroy(), timeoutMs);
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
  createWorkerReader(
    socket,
    (message) => {
      if (socket.destroyed) return;
      if (!accepted) {
        if (message.type !== "serve_protocol_hello" || message.sessionId !== sessionId) {
          callbacks.onError(new Error("Serve IPC protocol handshake rejected"));
          socket.destroy();
          return;
        }
        accepted = true;
        clearTimeout(timeout);
        callbacks.onAccepted();
        return;
      }
      if (message.type === "serve_protocol_hello") {
        callbacks.onError(new Error("Duplicate serve IPC protocol hello"));
        socket.destroy();
        return;
      }
      callbacks.onMessage(message);
    },
    (error) => {
      if (socket.destroyed) return;
      callbacks.onError(error);
      if (!accepted) socket.destroy();
    },
  );
}

// serve 进程快速 stop+start 时，旧 socket 的 close 事件可能还没触发，新 serve 已经连上来。
// session-worker 只允许一条活跃的 serveSocket：新连接协商成功后显式 destroy 旧的，避免两条
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

export function acceptCurrentServeSocketMessage(
  current: Socket | null,
  candidate: Socket,
): boolean {
  if (current === candidate) return true;
  candidate.destroy();
  return false;
}

// A close/error event from the socket destroyed during takeover may arrive after the replacement
// became current. Only the current socket is allowed to clear connection state or reject work.
export function releaseServeSocket(
  current: Socket | null,
  closed: Socket,
  onCurrentClosed: () => void,
): Socket | null {
  if (current !== closed) return current;
  onCurrentClosed();
  return null;
}
