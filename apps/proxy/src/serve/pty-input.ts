import { serializeIpc } from "../ipc/ipc-protocol.js";

export function serializeRawPtyInput(sessionId: string, data: string): string {
  return serializeIpc({ type: "pty_input", sessionId, data });
}
