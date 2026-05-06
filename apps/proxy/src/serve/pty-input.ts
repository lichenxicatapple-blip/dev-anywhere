import { serializeIpc } from "../ipc/ipc-protocol.js";

export function serializeRawPtyInput(sessionId: string, data: string): string {
  return serializeIpc({ type: "pty_input", sessionId, data });
}

export function serializeBatchPtyInput(sessionId: string, text: string): string {
  return serializeRawPtyInput(sessionId, `${text}\r`);
}
