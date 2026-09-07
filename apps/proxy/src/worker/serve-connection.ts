import type { Socket } from "node:net";
import { createWorkerReader, type WorkerMessage } from "../ipc/ipc-protocol.js";
import { readWorkerConnection } from "../ipc/worker-connection.js";

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
  readWorkerConnection<WorkerMessage>(socket, {
    read: createWorkerReader,
    isHello: (message) => message.type === "serve_protocol_hello",
    acceptHello: (message) =>
      message.type === "serve_protocol_hello" && message.sessionId === sessionId,
    ...callbacks,
    timeoutMs,
  });
}
