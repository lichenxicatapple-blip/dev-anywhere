import type { Socket } from "node:net";

interface WorkerConnectionOptions<Message> {
  read: (
    socket: Socket,
    onMessage: (message: Message) => void,
    onError: (error: Error) => void,
  ) => void;
  isHello: (message: Message) => boolean;
  acceptHello: (message: Message) => boolean;
  onAccepted: (message: Message) => void;
  onMessage: (message: Message) => void;
  onError: (error: Error) => void;
  timeoutMs?: number;
}

/** Admit a peer's hello before exposing state or allowing it to replace an active connection.
 * Windows pipe readers can connect without write access, so listeners must remain silent until
 * the peer writes an accepted hello. Protocol parsing and identity checks belong to the caller. */
export function readWorkerConnection<Message>(
  socket: Socket,
  options: WorkerConnectionOptions<Message>,
): void {
  let accepted = false;
  const timeout = setTimeout(() => socket.destroy(), options.timeoutMs ?? 5_000);
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
  options.read(
    socket,
    (message) => {
      if (socket.destroyed) return;
      if (!accepted) {
        if (!options.isHello(message) || !options.acceptHello(message)) {
          options.onError(new Error("Worker connection handshake rejected"));
          socket.destroy();
          return;
        }
        accepted = true;
        clearTimeout(timeout);
        options.onAccepted(message);
        return;
      }
      if (options.isHello(message)) {
        options.onError(new Error("Duplicate worker connection hello"));
        socket.destroy();
        return;
      }
      options.onMessage(message);
    },
    (error) => {
      if (socket.destroyed) return;
      options.onError(error);
      if (!accepted) socket.destroy();
    },
  );
}

/** Call only after admitting the replacement, so an unverified peer cannot evict the owner. */
export function takeoverWorkerSocket(previous: Socket | null, next: Socket): Socket {
  if (previous && previous !== next) {
    try {
      previous.destroy();
    } catch {
      // The previous connection may already be half-closed.
    }
  }
  return next;
}

export function acceptCurrentWorkerSocketMessage(
  current: Socket | null,
  candidate: Socket,
): boolean {
  if (current === candidate) return true;
  candidate.destroy();
  return false;
}

/** Late close/error events from a replaced socket must not clear its successor's state. */
export function releaseWorkerSocket(
  current: Socket | null,
  closed: Socket,
  onCurrentClosed: () => void,
): Socket | null {
  if (current !== closed) return current;
  onCurrentClosed();
  return null;
}
