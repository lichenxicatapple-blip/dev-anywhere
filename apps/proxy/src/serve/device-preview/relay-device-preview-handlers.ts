import { ControlErrorCode, serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../../common/logger.js";
import type { RelaySend } from "../relay-router-types.js";
import { DevicePreviewManager, DevicePreviewOperationError } from "./device-preview-manager.js";
import {
  PreviewOperationJournal,
  PreviewOperationJournalError,
} from "../preview/preview-operation-journal.js";

interface RelayDevicePreviewHandlersOptions {
  relaySend: RelaySend;
  manager: DevicePreviewManager;
  operationJournal: PreviewOperationJournal;
}

function requestError(error: unknown): { error: string; errorCode: ControlErrorCode } {
  if (error instanceof PreviewOperationJournalError) {
    return { error: error.message, errorCode: error.errorCode };
  }
  if (error instanceof DevicePreviewOperationError) {
    return { error: error.message, errorCode: error.errorCode };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    errorCode: ControlErrorCode.UNKNOWN,
  };
}

export class RelayDevicePreviewHandlers {
  constructor(private readonly options: RelayDevicePreviewHandlersOptions) {}

  async onCapability(msg: ControlMessage<"device_preview_capability_request">): Promise<void> {
    try {
      const capability = await this.options.manager.inspectCapabilities(msg.refreshPath);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_capability_response",
          requestId: msg.requestId,
          scope: msg.scope,
          success: true,
          capability,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_capability_response",
          requestId: msg.requestId,
          scope: msg.scope,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onTargets(msg: ControlMessage<"device_preview_targets_request">): Promise<void> {
    try {
      const targets = await this.options.manager.discoverTargets(msg.refresh);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_targets_response",
          requestId: msg.requestId,
          scope: msg.scope,
          success: true,
          targets,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_targets_response",
          requestId: msg.requestId,
          scope: msg.scope,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onCreate(msg: ControlMessage<"device_preview_create_request">): Promise<void> {
    try {
      const preview = await this.options.operationJournal.run(
        msg.operationId,
        "device:create",
        { targetId: msg.targetId, name: msg.name ?? null },
        () => this.options.manager.create(msg.targetId, msg.name),
      );
      this.options.relaySend(
        serializeControl({
          type: "device_preview_create_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          accepted: true,
          previewId: preview.previewId,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_create_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          accepted: false,
          ...requestError(error),
        }),
      );
    }
  }

  onList(msg: ControlMessage<"device_preview_list_request">): void {
    this.options.relaySend(
      serializeControl({
        type: "device_preview_list_response",
        requestId: msg.requestId,
        scope: msg.scope,
        ...this.options.manager.list(),
      }),
    );
  }

  async onRename(msg: ControlMessage<"device_preview_rename_request">): Promise<void> {
    try {
      await this.options.operationJournal.run(
        msg.operationId,
        "device:rename",
        { previewId: msg.previewId, name: msg.name },
        () => this.options.manager.rename(msg.previewId, msg.name),
      );
      this.options.relaySend(
        serializeControl({
          type: "device_preview_rename_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_rename_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onReconnect(msg: ControlMessage<"device_preview_reconnect_request">): Promise<void> {
    try {
      await this.options.operationJournal.run(
        msg.operationId,
        "device:reconnect",
        { previewId: msg.previewId },
        () => this.options.manager.reconnect(msg.previewId),
      );
      this.options.relaySend(
        serializeControl({
          type: "device_preview_reconnect_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_reconnect_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onClose(msg: ControlMessage<"device_preview_close_request">): Promise<void> {
    try {
      await this.options.operationJournal.run(
        msg.operationId,
        "device:close",
        { previewId: msg.previewId },
        () => this.options.manager.close(msg.previewId),
      );
      this.options.relaySend(
        serializeControl({
          type: "device_preview_close_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_close_response",
          requestId: msg.requestId,
          scope: msg.scope,
          operationId: msg.operationId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  async onStreamStart(msg: ControlMessage<"device_preview_stream_start">): Promise<void> {
    try {
      const stream = await this.options.manager.startStream(msg);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_stream_start_response",
          ...stream,
          success: true,
        }),
      );
    } catch (error) {
      serviceLogger.warn(
        { previewId: msg.previewId, streamId: msg.streamId, error: String(error) },
        "Device preview stream start failed",
      );
      this.options.relaySend(
        serializeControl({
          type: "device_preview_stream_start_response",
          streamId: msg.streamId,
          leaseId: msg.leaseId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  onStreamStop(msg: ControlMessage<"device_preview_stream_stop">): void {
    this.options.manager.stopStream(msg.streamId);
  }

  onInputRevoke(msg: ControlMessage<"device_preview_input_revoke">): void {
    this.options.manager.revokeInput(msg.leaseId);
  }

  async onInput(msg: ControlMessage<"device_preview_input">): Promise<void> {
    try {
      await this.options.manager.sendInput(msg.leaseId, msg.inputSeq, msg.input);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_input_ack",
          scope: msg.scope,
          leaseId: msg.leaseId,
          inputSeq: msg.inputSeq,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_input_ack",
          scope: msg.scope,
          leaseId: msg.leaseId,
          inputSeq: msg.inputSeq,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }
}
