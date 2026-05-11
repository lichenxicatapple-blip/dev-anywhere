import type { Socket } from "node:net";
import {
  ControlErrorCode,
  MessageEnvelopeSchema,
  serializeControl,
  type ControlMessage,
  type Envelope,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { saveClipboardImageUpload } from "./clipboard-image-upload.js";
import { loadFileDownload } from "./file-download.js";
import { saveFileUpload } from "./file-upload.js";
import { loadImagePreview } from "./image-preview.js";
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
  previewRoots?: string[];
}

export class RelayInputHandlers {
  constructor(private readonly deps: RelayInputHandlersDeps) {}

  onUserInput(msg: Envelope<"user_input">): void {
    const { sessionId } = msg;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      serviceLogger.warn({ sessionId }, "Remote input dropped: session not found");
      return;
    }

    const text = msg.payload.text;

    if (session.mode === "json") {
      // 必须先 send 成功再 onTurnStart：onTurnStart 把 session 推到 WORKING，但 send 失败时
      // 没有 onTurnResult / onChannelBroken 回到 IDLE，session 会卡 WORKING 直到 60s reaper。
      const sent = this.deps.workerRegistry.send(sessionId, {
        type: "worker_input",
        content: text,
      });
      if (!sent) {
        serviceLogger.warn({ sessionId }, "Remote input dropped: JSON worker socket not available");
        return;
      }
      this.deps.jsonObserver.onTurnStart(sessionId);
      const messageId =
        msg.payload.messageId && msg.payload.messageId.length > 0
          ? msg.payload.messageId
          : `${sessionId}-user-${msg.timestamp}`;
      this.deps.relayConnection.sendEnvelope(
        MessageEnvelopeSchema.parse({
          type: "user_input",
          sessionId,
          seq: msg.seq,
          timestamp: msg.timestamp,
          source: "proxy",
          version: msg.version,
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

  onRemoteInputRaw(msg: ControlMessage<"remote_input_raw">): void {
    const { sessionId, data } = msg;
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

  onClipboardImageUpload(msg: ControlMessage<"clipboard_image_upload">): void {
    const { sessionId, requestId } = msg;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.deps.relayConnection.sendRaw(
        serializeControl({
          type: "clipboard_image_upload_response",
          requestId,
          sessionId,
          success: false,
          error: "会话不存在",
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        }),
      );
      serviceLogger.warn({ sessionId }, "Clipboard image upload rejected: session not found");
      return;
    }

    const result = saveClipboardImageUpload(
      {
        sessionId,
        mimeType: msg.mimeType,
        dataBase64: msg.dataBase64,
        fileName: msg.fileName,
      },
      {
        cwd: session.cwd,
      },
    );

    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "clipboard_image_upload_response",
        requestId,
        sessionId,
        ...result,
      }),
    );
    serviceLogger.info({ sessionId, success: result.success }, "Clipboard image upload handled");
  }

  onImagePreviewRequest(msg: ControlMessage<"image_preview_request">): void {
    const { sessionId, requestId, path } = msg;
    if (!sessionId || !path) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.deps.relayConnection.sendRaw(
        serializeControl({
          type: "image_preview_response",
          requestId,
          sessionId,
          success: false,
          path,
          error: "会话不存在",
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        }),
      );
      serviceLogger.warn({ sessionId }, "Image preview rejected: session not found");
      return;
    }

    const result = loadImagePreview(
      { sessionId, path },
      {
        cwd: session.cwd,
        previewRoots: this.deps.previewRoots,
      },
    );

    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "image_preview_response",
        requestId,
        ...result,
      }),
    );
    if (result.success) {
      serviceLogger.info({ sessionId, path, size: result.size }, "Image preview handled");
    } else {
      serviceLogger.warn(
        { sessionId, path, errorCode: result.errorCode, error: result.error },
        "Image preview failed",
      );
    }
  }

  onFileDownloadRequest(msg: ControlMessage<"file_download_request">): void {
    const { sessionId, requestId, path } = msg;
    if (!sessionId || !path) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.deps.relayConnection.sendRaw(
        serializeControl({
          type: "file_download_response",
          requestId,
          sessionId,
          success: false,
          path,
          error: "会话不存在",
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        }),
      );
      serviceLogger.warn({ sessionId }, "File download rejected: session not found");
      return;
    }

    const result = loadFileDownload({ sessionId, path }, { cwd: session.cwd });

    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "file_download_response",
        requestId,
        ...result,
      }),
    );
    if (result.success) {
      serviceLogger.info(
        { sessionId, path, size: result.size },
        "File download handled",
      );
    } else {
      // 失败必带 errorCode + error, 否则只看 success=false 不知道是 ENOENT / EACCES / 超大 / 不是文件。
      serviceLogger.warn(
        { sessionId, path, errorCode: result.errorCode, error: result.error },
        "File download failed",
      );
    }
  }

  async onFileUploadRequest(msg: ControlMessage<"file_upload_request">): Promise<void> {
    const { sessionId, requestId, mimeType, dataBase64, fileName } = msg;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.deps.relayConnection.sendRaw(
        serializeControl({
          type: "file_upload_response",
          requestId,
          sessionId,
          success: false,
          error: "会话不存在",
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
        }),
      );
      serviceLogger.warn({ sessionId }, "File upload rejected: session not found");
      return;
    }

    const result = await saveFileUpload(
      { sessionId, mimeType, dataBase64, fileName },
      { cwd: session.cwd },
    );

    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "file_upload_response",
        requestId,
        sessionId,
        ...result,
      }),
    );
    if (result.success) {
      serviceLogger.info({ sessionId, fileName, path: result.path }, "File upload handled");
    } else {
      serviceLogger.warn(
        { sessionId, fileName, errorCode: result.errorCode, error: result.error },
        "File upload failed",
      );
    }
  }
}
