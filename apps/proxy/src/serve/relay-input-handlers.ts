import type { Socket } from "node:net";
import { ControlErrorCode, MessageEnvelopeSchema } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { saveClipboardImageUpload } from "./clipboard-image-upload.js";
import { serializeRawPtyInput } from "./pty-input.js";
import type { HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { JsonObserver } from "./json-observer.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

interface RelayInputHandlersDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  relayConnection: RelayConnection;
  terminalSockets: Map<string, Socket>;
  hostedPtyRegistry: HostedPtyRegistry;
  jsonObserver: JsonObserver;
}

export class RelayInputHandlers {
  constructor(private readonly deps: RelayInputHandlersDeps) {}

  onUserInput(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      serviceLogger.warn({ sessionId }, "Remote input dropped: session not found");
      return;
    }

    const payload = msg.payload as { text?: string; messageId?: string } | undefined;
    const text = payload?.text ?? "";

    if (session.mode === "json") {
      this.deps.jsonObserver.onTurnStart(sessionId);
      const sent = this.deps.workerRegistry.send(sessionId, {
        type: "worker_input",
        content: text,
      });
      if (!sent) {
        serviceLogger.warn({ sessionId }, "Remote input dropped: JSON worker socket not available");
        return;
      }
      const timestamp =
        typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
          ? msg.timestamp
          : Date.now();
      const seq =
        typeof msg.seq === "number" && Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
      const version = typeof msg.version === "string" ? msg.version : "1";
      const messageId =
        typeof payload?.messageId === "string" && payload.messageId.length > 0
          ? payload.messageId
          : `${sessionId}-user-${timestamp}`;
      this.deps.relayConnection.sendEnvelope(
        MessageEnvelopeSchema.parse({
          type: "user_input",
          sessionId,
          seq,
          timestamp,
          source: "proxy",
          version,
          payload: { text, messageId },
        }),
      );
      serviceLogger.info({ sessionId }, "Remote input forwarded to JSON worker");
      return;
    }

    serviceLogger.warn(
      { sessionId, mode: session.mode },
      "Remote batch input dropped: PTY sessions require remote_input_raw",
    );
  }

  onRemoteInputRaw(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const data = msg.data as string | undefined;
    if (!sessionId || data === undefined) return;

    const ts = this.deps.terminalSockets.get(sessionId);
    if (!ts?.writable && this.deps.hostedPtyRegistry.write(sessionId, data)) {
      serviceLogger.info(
        { sessionId, bytes: data.length },
        "Raw PTY input forwarded to hosted PTY",
      );
      return;
    }
    if (!ts?.writable) {
      serviceLogger.warn({ sessionId }, "Raw PTY input dropped: terminal socket unavailable");
      return;
    }
    ts.write(serializeRawPtyInput(sessionId, data));
    serviceLogger.info({ sessionId, bytes: data.length }, "Raw PTY input forwarded");
  }

  onClipboardImageUpload(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const requestId = msg.requestId as string | undefined;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.deps.relayConnection.sendRaw(
        JSON.stringify({
          type: "clipboard_image_upload_response",
          requestId,
          sessionId,
          success: false,
          path: "",
          error: "会话不存在",
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        }),
      );
      serviceLogger.warn({ sessionId }, "Clipboard image upload rejected: session not found");
      return;
    }

    const result = saveClipboardImageUpload({
      sessionId,
      mimeType: typeof msg.mimeType === "string" ? msg.mimeType : "",
      dataBase64: typeof msg.dataBase64 === "string" ? msg.dataBase64 : "",
      fileName: typeof msg.fileName === "string" ? msg.fileName : undefined,
    });

    this.deps.relayConnection.sendRaw(
      JSON.stringify({
        type: "clipboard_image_upload_response",
        requestId,
        sessionId,
        ...result,
      }),
    );
    serviceLogger.info({ sessionId, success: result.success }, "Clipboard image upload handled");
  }
}
