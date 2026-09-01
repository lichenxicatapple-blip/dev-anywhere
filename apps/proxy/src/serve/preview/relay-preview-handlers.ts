import { ControlErrorCode, serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../../common/logger.js";
import type { RelaySend } from "../relay-router-types.js";
import { PreviewManager, PreviewOperationError } from "./preview-manager.js";

interface RelayPreviewHandlersOptions {
  relaySend: RelaySend;
  previewManager: PreviewManager;
}

function requestError(error: unknown): { error: string; errorCode: ControlErrorCode } {
  if (error instanceof PreviewOperationError) {
    return { error: error.message, errorCode: error.errorCode };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    errorCode: ControlErrorCode.UNKNOWN,
  };
}

export class RelayPreviewHandlers {
  constructor(private readonly options: RelayPreviewHandlersOptions) {}

  async onStaticInspect(msg: ControlMessage<"preview_static_inspect_request">): Promise<void> {
    try {
      const inspection = await this.options.previewManager.inspectStatic(msg.path);
      this.options.relaySend(
        serializeControl({
          type: "preview_static_inspect_response",
          requestId: msg.requestId,
          success: true,
          rootPath: inspection.rootPath,
          ...(inspection.entryPath ? { entryPath: inspection.entryPath } : {}),
          htmlEntries: inspection.htmlEntries,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "preview_static_inspect_response",
          requestId: msg.requestId,
          success: false,
          errorCode: ControlErrorCode.INVALID_PATH,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async onCreate(msg: ControlMessage<"preview_create_request">): Promise<void> {
    try {
      const preview = await this.options.previewManager.create(
        msg.operationId,
        msg.source,
        msg.tunnelProvider,
      );
      this.options.relaySend(
        serializeControl({
          type: "preview_create_response",
          requestId: msg.requestId,
          operationId: msg.operationId,
          accepted: true,
          previewId: preview.previewId,
        }),
      );
      this.options.previewManager.announce(preview.previewId);
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "preview_create_response",
          requestId: msg.requestId,
          operationId: msg.operationId,
          accepted: false,
          ...requestError(error),
        }),
      );
    }
  }

  onList(msg: ControlMessage<"preview_list_request">): void {
    const snapshot = this.options.previewManager.list();
    this.options.relaySend(
      serializeControl({
        type: "preview_list_response",
        requestId: msg.requestId,
        ...snapshot,
      }),
    );
  }

  async onReconnect(msg: ControlMessage<"preview_reconnect_request">): Promise<void> {
    try {
      await this.options.previewManager.reconnect(msg.previewId);
      this.options.relaySend(
        serializeControl({
          type: "preview_reconnect_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "preview_reconnect_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onClose(msg: ControlMessage<"preview_close_request">): Promise<void> {
    try {
      await this.options.previewManager.close(msg.previewId);
      this.options.relaySend(
        serializeControl({
          type: "preview_close_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      serviceLogger.warn(
        { previewId: msg.previewId, error: String(error) },
        "Web preview close failed",
      );
      this.options.relaySend(
        serializeControl({
          type: "preview_close_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }
}
