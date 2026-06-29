import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import {
  ControlErrorCode,
  decodeFileStreamFrame,
  encodeFileStreamFrame,
  serializeControl,
  type ControlMessage,
} from "@dev-anywhere/shared";
import type { ControlErrorCode as ControlErrorCodeType } from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { RelayRegistry } from "./registry.js";

const REMOTE_FILE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REMOTE_FILE_METADATA_TIMEOUT_MS = 30 * 1000;
const REMOTE_FILE_UPLOAD_RESPONSE_TIMEOUT_MS = 60 * 1000;

type RemoteFileDisposition = "inline" | "download";
type RemoteFileUploadKind = "clipboard_image" | "file";

interface RemoteFileToken {
  token: string;
  clientId: string;
  proxyId: string;
  sessionId: string;
  path: string;
  disposition: RemoteFileDisposition;
  expiresAt: number;
}

type RemoteFileUrlResult =
  | { success: true; path: string; url: string; expiresAt: number }
  | { success: false; path: string; error: string; errorCode?: ControlErrorCodeType };

interface PendingUrlMetadata {
  requestId: string;
  clientId: string;
  proxyId: string;
  sessionId: string;
  path: string;
  disposition: RemoteFileDisposition;
  timer: NodeJS.Timeout;
  resolve: (result: RemoteFileUrlResult) => void;
}

interface PendingHttpStream {
  streamId: string;
  token: RemoteFileToken;
  res: Response;
  metadataTimer: NodeJS.Timeout;
  headersSent: boolean;
  finished: boolean;
}

interface RemoteFileUploadToken {
  token: string;
  clientId: string;
  proxyId: string;
  sessionId: string;
  kind: RemoteFileUploadKind;
  fileName?: string;
  mimeType: string;
  size?: number;
  expiresAt: number;
}

interface PendingHttpUpload {
  uploadId: string;
  token: RemoteFileUploadToken;
  res: Response;
  chunkSeq: number;
  requestEnded: boolean;
  finished: boolean;
  responseTimer: NodeJS.Timeout | null;
}

interface RemoteFileBridgeDeps {
  registry: RelayRegistry;
  logger: Logger;
}

function encodeContentDisposition(disposition: RemoteFileDisposition, fileName: string): string {
  const type = disposition === "download" ? "attachment" : "inline";
  const fallback = fileName.replace(/["\\\r\n]/g, "_") || "download";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function statusForErrorCode(errorCode?: string): number {
  switch (errorCode) {
    case ControlErrorCode.SESSION_NOT_FOUND:
    case ControlErrorCode.PATH_NOT_FOUND:
      return 404;
    case ControlErrorCode.INVALID_PATH:
    case ControlErrorCode.PATH_NOT_DIRECTORY:
      return 400;
    case ControlErrorCode.PATH_ACCESS_DENIED:
      return 403;
    default:
      return 500;
  }
}

export class RemoteFileBridge {
  private readonly tokens = new Map<string, RemoteFileToken>();
  private readonly uploadTokens = new Map<string, RemoteFileUploadToken>();
  private readonly pendingUrlMetadata = new Map<string, PendingUrlMetadata>();
  private readonly pendingStreams = new Map<string, PendingHttpStream>();
  private readonly pendingUploads = new Map<string, PendingHttpUpload>();

  constructor(private readonly deps: RemoteFileBridgeDeps) {}

  createUrl(input: {
    clientId: string;
    proxyId: string;
    sessionId: string;
    path: string;
    disposition: RemoteFileDisposition;
  }): Promise<RemoteFileUrlResult> {
    this.cleanupExpiredTokens();
    const proxyWs = this.deps.registry.getProxy(input.proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        success: false,
        path: input.path,
        error: "当前未连接开发机",
        errorCode: ControlErrorCode.PROXY_OFFLINE,
      });
    }

    const requestId = nanoid(21);
    return new Promise<RemoteFileUrlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUrlMetadata.delete(requestId);
        resolve({
          success: false,
          path: input.path,
          error: "读取文件元数据超时",
          errorCode: ControlErrorCode.UNKNOWN,
        });
      }, REMOTE_FILE_METADATA_TIMEOUT_MS);

      this.pendingUrlMetadata.set(requestId, {
        requestId,
        clientId: input.clientId,
        proxyId: input.proxyId,
        sessionId: input.sessionId,
        path: input.path,
        disposition: input.disposition,
        timer,
        resolve,
      });

      proxyWs.send(
        serializeControl({
          type: "remote_file_metadata_request",
          requestId,
          sessionId: input.sessionId,
          path: input.path,
        }),
      );
      this.deps.logger.info(
        { requestId, proxyId: input.proxyId, sessionId: input.sessionId, path: input.path },
        "Remote file URL metadata requested",
      );
    });
  }

  createUploadUrl(input: {
    clientId: string;
    proxyId: string;
    sessionId: string;
    kind: RemoteFileUploadKind;
    fileName?: string;
    mimeType: string;
    size?: number;
  }): { uploadUrl: string; expiresAt: number } {
    this.cleanupExpiredTokens();
    const token = nanoid(32);
    const expiresAt = Date.now() + REMOTE_FILE_TOKEN_TTL_MS;
    this.uploadTokens.set(token, {
      token,
      clientId: input.clientId,
      proxyId: input.proxyId,
      sessionId: input.sessionId,
      kind: input.kind,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      expiresAt,
    });
    return { uploadUrl: `/api/remote-uploads/${token}`, expiresAt };
  }

  handleHttpRequest(req: Request, res: Response): void {
    const tokenValue = req.params.token;
    const token = typeof tokenValue === "string" ? this.tokens.get(tokenValue) : undefined;
    if (!token || token.expiresAt <= Date.now()) {
      if (typeof tokenValue === "string") this.tokens.delete(tokenValue);
      res.status(404).json({ error: "remote_file_url_expired" });
      return;
    }

    const proxyWs = this.deps.registry.getProxy(token.proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      res.status(502).json({ error: "proxy_offline" });
      return;
    }

    const streamId = nanoid(21);
    const metadataTimer = setTimeout(() => {
      this.failStream(streamId, 504, "读取文件元数据超时");
    }, REMOTE_FILE_METADATA_TIMEOUT_MS);
    const pending: PendingHttpStream = {
      streamId,
      token,
      res,
      metadataTimer,
      headersSent: false,
      finished: false,
    };
    this.pendingStreams.set(streamId, pending);

    res.on("close", () => {
      if (pending.finished) return;
      pending.finished = true;
      this.pendingStreams.delete(streamId);
      clearTimeout(metadataTimer);
      this.sendCancel(token.proxyId, streamId);
      this.deps.logger.info({ streamId, proxyId: token.proxyId }, "Remote file HTTP stream closed");
    });

    proxyWs.send(
      serializeControl({
        type: "remote_file_stream_request",
        streamId,
        sessionId: token.sessionId,
        path: token.path,
        disposition: token.disposition,
      }),
    );
    this.deps.logger.info(
      { streamId, proxyId: token.proxyId, sessionId: token.sessionId, path: token.path },
      "Remote file HTTP stream requested",
    );
  }

  handleUploadHttpRequest(req: Request, res: Response): void {
    const tokenValue = req.params.token;
    const token = typeof tokenValue === "string" ? this.uploadTokens.get(tokenValue) : undefined;
    if (!token || token.expiresAt <= Date.now()) {
      if (typeof tokenValue === "string") this.uploadTokens.delete(tokenValue);
      res.status(404).json({ error: "remote_file_upload_url_expired" });
      return;
    }

    const proxyWs = this.deps.registry.getProxy(token.proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) {
      res.status(502).json({ error: "proxy_offline" });
      return;
    }

    const uploadId = nanoid(21);
    const pending: PendingHttpUpload = {
      uploadId,
      token,
      res,
      chunkSeq: 0,
      requestEnded: false,
      finished: false,
      responseTimer: null,
    };
    this.pendingUploads.set(uploadId, pending);

    proxyWs.send(
      serializeControl({
        type: "remote_file_upload_stream_request",
        uploadId,
        sessionId: token.sessionId,
        kind: token.kind,
        mimeType: token.mimeType,
        ...(token.fileName ? { fileName: token.fileName } : {}),
        ...(token.size !== undefined ? { size: token.size } : {}),
      }),
    );

    req.on("data", (chunk: Buffer) => {
      if (pending.finished) return;
      req.pause();
      const frame = encodeFileStreamFrame(uploadId, pending.chunkSeq, Buffer.from(chunk));
      pending.chunkSeq += 1;
      proxyWs.send(frame, { binary: true }, (err) => {
        if (err) {
          this.failUpload(uploadId, 502, err.message);
          return;
        }
        req.resume();
      });
    });

    req.on("end", () => {
      if (pending.finished) return;
      pending.requestEnded = true;
      pending.responseTimer = setTimeout(() => {
        this.failUpload(uploadId, 504, "等待上传写入结果超时");
      }, REMOTE_FILE_UPLOAD_RESPONSE_TIMEOUT_MS);
      proxyWs.send(serializeControl({ type: "remote_file_upload_stream_complete", uploadId }));
    });

    req.on("error", (err) => {
      this.failUpload(uploadId, 400, err.message);
    });

    req.on("close", () => {
      if (pending.finished || pending.requestEnded) return;
      this.failUpload(uploadId, 499, "上传请求已断开");
    });

    this.deps.logger.info(
      { uploadId, proxyId: token.proxyId, sessionId: token.sessionId, kind: token.kind },
      "Remote file HTTP upload requested",
    );
  }

  handleProxyControl(proxyId: string, msg: ControlMessage<"remote_file_stream_response">): boolean;
  handleProxyControl(proxyId: string, msg: ControlMessage<"remote_file_stream_complete">): boolean;
  handleProxyControl(
    proxyId: string,
    msg: ControlMessage<"remote_file_metadata_response">,
  ): boolean;
  handleProxyControl(
    proxyId: string,
    msg: ControlMessage<"remote_file_upload_stream_response">,
  ): boolean;
  handleProxyControl(
    proxyId: string,
    msg:
      | ControlMessage<"remote_file_stream_response">
      | ControlMessage<"remote_file_stream_complete">
      | ControlMessage<"remote_file_metadata_response">
      | ControlMessage<"remote_file_upload_stream_response">,
  ): boolean {
    if (msg.type === "remote_file_upload_stream_response") {
      return this.handleUploadResponse(proxyId, msg);
    }

    if (msg.type === "remote_file_metadata_response") {
      return this.handleUrlMetadataResponse(proxyId, msg);
    }

    const pending = this.pendingStreams.get(msg.streamId);
    if (!pending) return true;
    if (pending.token.proxyId !== proxyId) {
      this.deps.logger.warn(
        { streamId: msg.streamId, expectedProxyId: pending.token.proxyId, proxyId },
        "Remote file stream control ignored: proxy mismatch",
      );
      return true;
    }

    if (msg.type === "remote_file_stream_response") {
      this.handleStreamResponse(pending, msg);
      return true;
    }

    this.handleStreamComplete(pending, msg);
    return true;
  }

  private issueUrlToken(input: {
    clientId: string;
    proxyId: string;
    sessionId: string;
    path: string;
    disposition: RemoteFileDisposition;
  }): { url: string; expiresAt: number } {
    const token = nanoid(32);
    const expiresAt = Date.now() + REMOTE_FILE_TOKEN_TTL_MS;
    this.tokens.set(token, {
      token,
      clientId: input.clientId,
      proxyId: input.proxyId,
      sessionId: input.sessionId,
      path: input.path,
      disposition: input.disposition,
      expiresAt,
    });
    return { url: `/api/remote-files/${token}`, expiresAt };
  }

  private handleUrlMetadataResponse(
    proxyId: string,
    msg: ControlMessage<"remote_file_metadata_response">,
  ): boolean {
    const pending = this.pendingUrlMetadata.get(msg.requestId);
    if (!pending) return true;
    if (pending.proxyId !== proxyId) {
      this.deps.logger.warn(
        { requestId: msg.requestId, expectedProxyId: pending.proxyId, proxyId },
        "Remote file metadata ignored: proxy mismatch",
      );
      return true;
    }

    this.pendingUrlMetadata.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (!msg.success) {
      pending.resolve({
        success: false,
        path: pending.path,
        error: msg.error ?? "读取文件失败",
        ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
      });
      return true;
    }

    const { url, expiresAt } = this.issueUrlToken(pending);
    pending.resolve({
      success: true,
      path: pending.path,
      url,
      expiresAt,
    });
    return true;
  }

  handleProxyBinary(proxyId: string, data: Buffer): boolean {
    const decoded = decodeFileStreamFrame(data);
    if (!decoded) return false;

    const pending = this.pendingStreams.get(decoded.streamId);
    if (!pending) return true;
    if (pending.token.proxyId !== proxyId) {
      this.deps.logger.warn(
        { streamId: decoded.streamId, expectedProxyId: pending.token.proxyId, proxyId },
        "Remote file stream chunk ignored: proxy mismatch",
      );
      return true;
    }
    if (!pending.headersSent || pending.finished) return true;

    pending.res.write(Buffer.from(decoded.data));
    return true;
  }

  private handleStreamResponse(
    pending: PendingHttpStream,
    msg: ControlMessage<"remote_file_stream_response">,
  ): void {
    clearTimeout(pending.metadataTimer);
    if (!msg.success) {
      this.failStream(
        pending.streamId,
        statusForErrorCode(msg.errorCode),
        msg.error ?? "读取文件失败",
        msg.errorCode,
      );
      return;
    }

    pending.headersSent = true;
    pending.res.status(200);
    pending.res.setHeader("Content-Type", msg.mimeType ?? "application/octet-stream");
    pending.res.setHeader("Cache-Control", "no-store");
    pending.res.setHeader("X-Content-Type-Options", "nosniff");
    if (msg.size !== undefined) {
      pending.res.setHeader("Content-Length", String(msg.size));
    }
    pending.res.setHeader(
      "Content-Disposition",
      encodeContentDisposition(pending.token.disposition, msg.fileName ?? "download"),
    );
    pending.res.flushHeaders();
  }

  private handleStreamComplete(
    pending: PendingHttpStream,
    msg: ControlMessage<"remote_file_stream_complete">,
  ): void {
    clearTimeout(pending.metadataTimer);
    pending.finished = true;
    this.pendingStreams.delete(pending.streamId);
    if (!msg.success) {
      if (!pending.headersSent) {
        this.writeJsonError(
          pending.res,
          statusForErrorCode(msg.errorCode),
          msg.error ?? "读取文件失败",
          msg.errorCode,
        );
      } else {
        pending.res.destroy(new Error(msg.error ?? "Remote file stream failed"));
      }
      return;
    }
    pending.res.end();
  }

  private handleUploadResponse(
    proxyId: string,
    msg: ControlMessage<"remote_file_upload_stream_response">,
  ): boolean {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (!pending) return true;
    if (pending.token.proxyId !== proxyId) {
      this.deps.logger.warn(
        { uploadId: msg.uploadId, expectedProxyId: pending.token.proxyId, proxyId },
        "Remote file upload response ignored: proxy mismatch",
      );
      return true;
    }
    pending.finished = true;
    this.pendingUploads.delete(msg.uploadId);
    if (pending.responseTimer) clearTimeout(pending.responseTimer);
    if (!msg.success) {
      this.writeJsonError(
        pending.res,
        statusForErrorCode(msg.errorCode),
        msg.error ?? "上传文件失败",
        msg.errorCode,
      );
      return true;
    }
    pending.res.status(200).json({
      sessionId: msg.sessionId,
      success: true,
      path: msg.path,
    });
    return true;
  }

  private failStream(streamId: string, status: number, error: string, errorCode?: string): void {
    const pending = this.pendingStreams.get(streamId);
    if (!pending) return;
    pending.finished = true;
    this.pendingStreams.delete(streamId);
    clearTimeout(pending.metadataTimer);
    this.sendCancel(pending.token.proxyId, streamId);
    if (!pending.headersSent) {
      this.writeJsonError(pending.res, status, error, errorCode);
    } else {
      pending.res.destroy(new Error(error));
    }
  }

  private failUpload(uploadId: string, status: number, error: string, errorCode?: string): void {
    const pending = this.pendingUploads.get(uploadId);
    if (!pending) return;
    pending.finished = true;
    this.pendingUploads.delete(uploadId);
    if (pending.responseTimer) clearTimeout(pending.responseTimer);
    this.sendUploadCancel(pending.token.proxyId, uploadId);
    if (!pending.res.headersSent) {
      this.writeJsonError(pending.res, status, error, errorCode);
    } else {
      pending.res.destroy(new Error(error));
    }
  }

  private writeJsonError(res: Response, status: number, error: string, errorCode?: string): void {
    res.status(status).json({
      error,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private sendCancel(proxyId: string, streamId: string): void {
    const proxyWs = this.deps.registry.getProxy(proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) return;
    proxyWs.send(serializeControl({ type: "remote_file_stream_cancel", streamId }));
  }

  private sendUploadCancel(proxyId: string, uploadId: string): void {
    const proxyWs = this.deps.registry.getProxy(proxyId);
    if (!proxyWs || proxyWs.readyState !== WebSocket.OPEN) return;
    proxyWs.send(serializeControl({ type: "remote_file_upload_stream_cancel", uploadId }));
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, meta] of this.tokens) {
      if (meta.expiresAt <= now) this.tokens.delete(token);
    }
    for (const [token, meta] of this.uploadTokens) {
      if (meta.expiresAt <= now) this.uploadTokens.delete(token);
    }
  }
}
