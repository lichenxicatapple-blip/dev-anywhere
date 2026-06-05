import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { nanoid } from "nanoid";
import {
  ControlErrorCode,
  decodeFileStreamFrame,
  serializeControl,
  type ControlMessage,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { RelayConnection } from "./relay-connection.js";
import type { SessionManager } from "./session-manager.js";

const DEFAULT_DATA_DIR = join(tmpdir(), "dev-anywhere");
const SAFE_EXT_RE = /^[A-Za-z0-9]{1,6}$/;
const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
] as const);

interface RemoteFileUploadManagerDeps {
  relayConnection: RelayConnection;
  sessionManager: SessionManager;
  dataDir?: string;
  randomSuffix?: () => string;
}

interface ActiveUpload {
  sessionId: string;
  path: string;
  stream: WriteStream;
  bytes: number;
  completed: boolean;
}

function safeExtension(fileName?: string): string {
  const raw = extname(fileName ?? "")
    .slice(1)
    .toLowerCase();
  return SAFE_EXT_RE.test(raw) ? `.${raw}` : "";
}

function uploadPathFor(
  msg: ControlMessage<"remote_file_upload_stream_request">,
  dataDir: string,
  suffix: string,
): string {
  if (msg.kind === "clipboard_image") {
    const extension = IMAGE_EXTENSIONS.get(msg.mimeType);
    if (!extension) throw new Error("不支持这种图片格式");
    return join(dataDir, `paste-${suffix}.${extension}`);
  }
  return join(dataDir, `up-${suffix}${safeExtension(msg.fileName)}`);
}

export class RemoteFileUploadManager {
  private readonly activeUploads = new Map<string, ActiveUpload>();

  constructor(private readonly deps: RemoteFileUploadManagerDeps) {}

  start(msg: ControlMessage<"remote_file_upload_stream_request">): void {
    const { uploadId, sessionId } = msg;
    if (this.activeUploads.has(uploadId)) {
      this.sendResponse({
        uploadId,
        sessionId,
        success: false,
        error: "上传流已存在",
        errorCode: ControlErrorCode.UNKNOWN,
      });
      return;
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendResponse({
        uploadId,
        sessionId,
        success: false,
        error: "会话不存在",
        errorCode: ControlErrorCode.SESSION_NOT_FOUND,
      });
      return;
    }

    try {
      const dataDir = this.deps.dataDir ?? DEFAULT_DATA_DIR;
      mkdirSync(dataDir, { recursive: true });
      const path = uploadPathFor(msg, dataDir, this.deps.randomSuffix?.() ?? nanoid(6));
      const stream = createWriteStream(path, { mode: 0o600 });
      const active: ActiveUpload = {
        sessionId,
        path,
        stream,
        bytes: 0,
        completed: false,
      };
      this.activeUploads.set(uploadId, active);

      stream.on("error", (err) => {
        this.fail(uploadId, err instanceof Error ? err.message : String(err));
      });

      stream.on("finish", () => {
        if (!active.completed) return;
        this.activeUploads.delete(uploadId);
        this.sendResponse({
          uploadId,
          sessionId,
          success: true,
          path,
        });
        serviceLogger.info(
          { uploadId, sessionId, path, bytes: active.bytes },
          "Remote file upload completed",
        );
      });

      serviceLogger.info(
        { uploadId, sessionId, path, kind: msg.kind },
        "Remote file upload started",
      );
    } catch (err) {
      this.sendResponse({
        uploadId,
        sessionId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: ControlErrorCode.UNKNOWN,
      });
    }
  }

  handleBinary(data: Buffer): boolean {
    const frame = decodeFileStreamFrame(data);
    if (!frame) return false;
    const active = this.activeUploads.get(frame.streamId);
    if (!active || active.completed) return true;
    const chunk = Buffer.from(frame.data);
    active.bytes += chunk.length;
    active.stream.write(chunk);
    return true;
  }

  complete(msg: ControlMessage<"remote_file_upload_stream_complete">): void {
    const active = this.activeUploads.get(msg.uploadId);
    if (!active || active.completed) return;
    active.completed = true;
    active.stream.end();
  }

  cancel(msg: ControlMessage<"remote_file_upload_stream_cancel">): void {
    const active = this.activeUploads.get(msg.uploadId);
    if (!active) return;
    active.completed = true;
    this.activeUploads.delete(msg.uploadId);
    active.stream.destroy();
    serviceLogger.info({ uploadId: msg.uploadId }, "Remote file upload canceled");
  }

  private fail(uploadId: string, error: string): void {
    const active = this.activeUploads.get(uploadId);
    if (!active) return;
    active.completed = true;
    this.activeUploads.delete(uploadId);
    active.stream.destroy();
    this.sendResponse({
      uploadId,
      sessionId: active.sessionId,
      success: false,
      error,
      errorCode: ControlErrorCode.UNKNOWN,
    });
  }

  private sendResponse(
    payload: Omit<ControlMessage<"remote_file_upload_stream_response">, "type">,
  ): void {
    this.deps.relayConnection.sendRaw(
      serializeControl({
        type: "remote_file_upload_stream_response",
        ...payload,
      }),
    );
  }
}
