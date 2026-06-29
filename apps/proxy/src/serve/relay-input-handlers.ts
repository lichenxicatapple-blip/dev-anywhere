import type { Socket } from "node:net";
import {
  MessageEnvelopeSchema,
  isCompactCommandText,
  type ControlMessage,
  type Envelope,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { RemoteFileUploadManager } from "./remote-file-upload.js";
import type { RemoteFileStreamManager } from "./remote-file-stream.js";
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
  remoteFileStreamManager: RemoteFileStreamManager;
  remoteFileUploadManager: RemoteFileUploadManager;
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
      const isCompactCommand = isCompactCommandText(text);
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
      if (isCompactCommand) {
        this.deps.jsonObserver.onTurnStart(sessionId, { compacting: true });
      } else {
        this.deps.jsonObserver.onTurnStart(sessionId);
      }
      if (isCompactCommand) {
        serviceLogger.info({ sessionId }, "Remote compact command forwarded to JSON worker");
        return;
      }
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
    const { sessionId, data, traceId } = msg;
    if (!sessionId || data === undefined) return;

    const ts = this.deps.terminalSockets.get(sessionId);
    const hostedInputForwarded =
      !ts?.writable &&
      (traceId
        ? this.deps.hostedPtyRegistry.write(sessionId, data, traceId)
        : this.deps.hostedPtyRegistry.write(sessionId, data));
    if (hostedInputForwarded) {
      serviceLogger.info(
        { sessionId, traceId, bytes: data.length },
        "Raw PTY input forwarded to hosted PTY",
      );
      return;
    }
    if (!ts?.writable) {
      serviceLogger.warn(
        { sessionId, traceId },
        "Raw PTY input dropped: terminal socket unavailable",
      );
      return;
    }
    ts.write(serializeRawPtyInput(sessionId, data, traceId));
    serviceLogger.info({ sessionId, traceId, bytes: data.length }, "Raw PTY input forwarded");
  }

  onRemoteFileStreamRequest(msg: ControlMessage<"remote_file_stream_request">): void {
    this.deps.remoteFileStreamManager.start(msg);
  }

  onRemoteFileMetadataRequest(msg: ControlMessage<"remote_file_metadata_request">): void {
    this.deps.remoteFileStreamManager.metadata(msg);
  }

  onRemoteFileStreamCancel(msg: ControlMessage<"remote_file_stream_cancel">): void {
    this.deps.remoteFileStreamManager.cancel(msg);
  }

  onRemoteFileUploadStreamRequest(msg: ControlMessage<"remote_file_upload_stream_request">): void {
    this.deps.remoteFileUploadManager.start(msg);
  }

  onRemoteFileUploadStreamComplete(
    msg: ControlMessage<"remote_file_upload_stream_complete">,
  ): void {
    this.deps.remoteFileUploadManager.complete(msg);
  }

  onRemoteFileUploadStreamCancel(msg: ControlMessage<"remote_file_upload_stream_cancel">): void {
    this.deps.remoteFileUploadManager.cancel(msg);
  }
}
