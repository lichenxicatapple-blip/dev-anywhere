import type { Socket } from "node:net";
import { SOCK_PATH } from "../common/paths.js";
import { tryConnectSocket } from "../common/socket-connect.js";
import { createProfileServiceLifecycle } from "../common/profile-service.js";
import { createIpcReader, type IpcMessage } from "../ipc/ipc-protocol.js";

const WAIT_FOR_MESSAGE_TIMEOUT_MS = 10_000;

export class IpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpcProtocolError";
  }
}

type EnsureServiceIntent = "initial" | "reconnect" | "connect-only";

export function tryConnect(sockPath: string): Promise<Socket | null> {
  return tryConnectSocket(sockPath);
}

// The lifecycle controller owns startup; this adapter only opens the business connection.
export async function ensureService(intent: EnsureServiceIntent = "initial"): Promise<Socket> {
  if (intent !== "connect-only") {
    await createProfileServiceLifecycle().start(intent === "initial" ? "explicit" : "recover");
  }
  const socket = await tryConnect(SOCK_PATH);
  if (!socket) throw new Error("Service is not running");
  return socket;
}

// 等待指定类型的 IPC 消息一次。`createIpcReader` 注册临时 listener，匹配后立即清理。
// 协议错误、连接关闭或超时都会销毁本轮 socket 并 reject。
export function waitForMessage<T extends IpcMessage["type"]>(
  socket: Socket,
  messageType: T,
  timeoutMs = WAIT_FOR_MESSAGE_TIMEOUT_MS,
): Promise<Extract<IpcMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;
    let dispose = (): void => {};
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      dispose();
      socket.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onClose = (): void => fail(new Error(`Socket closed waiting for ${messageType}`));
    dispose = createIpcReader(
      socket,
      (msg: IpcMessage) => {
        if (msg.type === "error" && msg.code === "TERMINAL_ADMISSION_SCOPE_MISMATCH" && !settled) {
          fail(new IpcProtocolError(msg.message));
          return;
        }
        if (msg.type !== messageType || settled) return;
        settled = true;
        cleanup();
        resolve(msg as Extract<IpcMessage, { type: T }>);
      },
      undefined,
      (error, line) => {
        try {
          const raw: unknown = JSON.parse(line);
          if (
            raw !== null &&
            typeof raw === "object" &&
            !Array.isArray(raw) &&
            (raw as { type?: unknown }).type === messageType
          ) {
            fail(
              new IpcProtocolError(`Invalid ${messageType} for the current IPC protocol`, {
                cause: error,
              }),
            );
          }
        } catch {
          // A malformed line has no trustworthy message type and may be unrelated to this waiter.
        }
      },
    );
    socket.once("close", onClose);
    timeout = setTimeout(() => {
      fail(new Error(`Timeout waiting for ${messageType}`));
    }, timeoutMs);
  });
}
