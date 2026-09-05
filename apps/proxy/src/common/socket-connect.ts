import { connect, type Socket } from "node:net";

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

/** Only an absent listener is null; an unknown or inaccessible service must not be replaced. */
export function tryConnectSocket(
  socketPath: string,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Socket | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("Invalid socket connection timeout"));
  }
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = connect(socketPath);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const timer = setTimeout(
      () => finish(null, new Error("Service socket connection timed out")),
      timeoutMs,
    );
    const onConnect = () => finish(socket);
    const onError = (error: NodeJS.ErrnoException) =>
      finish(null, error.code === "ENOENT" || error.code === "ECONNREFUSED" ? undefined : error);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const finish = (result: Socket | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result) socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}
