import { createReadStream, statSync, type ReadStream } from "node:fs";
import { basename } from "node:path";
import {
  ControlErrorCode,
  encodeFileStreamFrame,
  serializeControl,
  type ControlMessage,
} from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import { classifyPathError } from "./path-errors.js";
import { guessMimeType, resolveRemoteFilePath } from "./remote-file-path.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";

const FILE_STREAM_CHUNK_BYTES = 256 * 1024;

interface RemoteFileStreamManagerDeps {
  relayConnection: RelayConnection;
  sessionManager: SessionManager;
}

interface ActiveFileStream {
  stream: ReadStream;
  chunkSeq: number;
  completed: boolean;
  canceled: boolean;
}

function errorCode(err: unknown): ControlErrorCodeType {
  if (
    err instanceof Error &&
    "errorCode" in err &&
    typeof (err as { errorCode?: unknown }).errorCode === "string"
  ) {
    return (err as { errorCode: ControlErrorCodeType }).errorCode;
  }
  return classifyPathError(err);
}

export class RemoteFileStreamManager {
  private readonly activeStreams = new Map<string, ActiveFileStream>();

  constructor(private readonly deps: RemoteFileStreamManagerDeps) {}

  start(msg: ControlMessage<"remote_file_stream_request">): void {
    const { streamId, sessionId, path } = msg;
    if (this.activeStreams.has(streamId)) {
      this.sendResponse({
        streamId,
        sessionId,
        success: false,
        error: "文件流已存在",
        errorCode: ControlErrorCode.UNKNOWN,
      });
      return;
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendResponse({
        streamId,
        sessionId,
        success: false,
        path,
        error: "会话不存在",
        errorCode: ControlErrorCode.SESSION_NOT_FOUND,
      });
      serviceLogger.warn({ sessionId, streamId }, "Remote file stream rejected: session not found");
      return;
    }

    try {
      const resolvedPath = resolveRemoteFilePath(path, session.cwd);
      const stat = statSync(resolvedPath);
      if (!stat.isFile()) {
        this.sendResponse({
          streamId,
          sessionId,
          success: false,
          path,
          error: "路径不是普通文件",
          errorCode: ControlErrorCode.INVALID_PATH,
        });
        return;
      }

      const stream = createReadStream(resolvedPath, { highWaterMark: FILE_STREAM_CHUNK_BYTES });
      const active: ActiveFileStream = {
        stream,
        chunkSeq: 0,
        completed: false,
        canceled: false,
      };
      this.activeStreams.set(streamId, active);

      this.sendResponse({
        streamId,
        sessionId,
        success: true,
        path,
        mimeType: guessMimeType(resolvedPath),
        size: stat.size,
        fileName: basename(resolvedPath) || "download",
      });

      stream.on("data", (chunk) => {
        if (active.canceled) return;
        const data = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        this.deps.relayConnection.sendBinary(
          encodeFileStreamFrame(streamId, active.chunkSeq, data),
        );
        active.chunkSeq += 1;
      });

      stream.on("end", () => {
        this.complete(streamId, true);
      });

      stream.on("error", (err) => {
        if (active.canceled) return;
        this.complete(streamId, false, err instanceof Error ? err.message : String(err));
      });

      stream.on("close", () => {
        if (!active.completed && !active.canceled) {
          this.complete(streamId, false, "文件流提前关闭");
        }
      });

      serviceLogger.info(
        { sessionId, streamId, path, size: stat.size },
        "Remote file stream started",
      );
    } catch (err) {
      this.sendResponse({
        streamId,
        sessionId,
        success: false,
        path,
        error: err instanceof Error ? err.message : String(err),
        errorCode: errorCode(err),
      });
      serviceLogger.warn(
        { sessionId, streamId, path, errorCode: errorCode(err), error: String(err) },
        "Remote file stream failed before start",
      );
    }
  }

  cancel(msg: ControlMessage<"remote_file_stream_cancel">): void {
    const active = this.activeStreams.get(msg.streamId);
    if (!active) return;
    active.canceled = true;
    active.completed = true;
    this.activeStreams.delete(msg.streamId);
    active.stream.destroy();
    serviceLogger.info({ streamId: msg.streamId }, "Remote file stream canceled");
  }

  private complete(streamId: string, success: boolean, error?: string): void {
    const active = this.activeStreams.get(streamId);
    if (active) {
      active.completed = true;
      this.activeStreams.delete(streamId);
    }
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "remote_file_stream_complete",
        streamId,
        success,
        ...(error ? { error, errorCode: ControlErrorCode.UNKNOWN } : {}),
      }),
    );
    serviceLogger.info({ streamId, success, error }, "Remote file stream completed");
  }

  private sendResponse(payload: Omit<ControlMessage<"remote_file_stream_response">, "type">): void {
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "remote_file_stream_response",
        ...payload,
      }),
    );
  }
}
