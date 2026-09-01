import { ControlErrorCode, serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import { serviceLogger } from "../../common/logger.js";
import type { RelaySend } from "../relay-router-types.js";
import { DevicePreviewManager } from "./device-preview-manager.js";

interface RelayDevicePreviewHandlersOptions {
  relaySend: RelaySend;
  manager: DevicePreviewManager;
}

function requestError(error: unknown): { error: string; errorCode: ControlErrorCode } {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorCode: ControlErrorCode.UNKNOWN,
  };
}

export class RelayDevicePreviewHandlers {
  constructor(private readonly options: RelayDevicePreviewHandlersOptions) {}

  async onCapability(msg: ControlMessage<"device_preview_capability_request">): Promise<void> {
    try {
      const capability = await this.options.manager.inspectCapabilities(msg.refreshPath ?? false);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_capability_response",
          requestId: msg.requestId,
          capability,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_capability_response",
          requestId: msg.requestId,
          ...requestError(error),
        }),
      );
    }
  }

  async onTargets(msg: ControlMessage<"device_preview_targets_request">): Promise<void> {
    try {
      const targets = await this.options.manager.discoverTargets(msg.refresh ?? false);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_targets_response",
          requestId: msg.requestId,
          success: true,
          targets,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_targets_response",
          requestId: msg.requestId,
          success: false,
          targets: [],
          ...requestError(error),
        }),
      );
    }
  }

  async onCreate(msg: ControlMessage<"device_preview_create_request">): Promise<void> {
    try {
      const preview = await this.options.manager.create(msg.operationId, msg.targetId);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_create_response",
          requestId: msg.requestId,
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
        ...this.options.manager.list(),
      }),
    );
  }

  async onReconnect(msg: ControlMessage<"device_preview_reconnect_request">): Promise<void> {
    try {
      await this.options.manager.reconnect(msg.previewId);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_reconnect_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_reconnect_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }

  onClose(msg: ControlMessage<"device_preview_close_request">): void {
    try {
      this.options.manager.close(msg.previewId);
      this.options.relaySend(
        serializeControl({
          type: "device_preview_close_response",
          requestId: msg.requestId,
          previewId: msg.previewId,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_close_response",
          requestId: msg.requestId,
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
          leaseId: msg.leaseId,
          inputSeq: msg.inputSeq,
          success: true,
        }),
      );
    } catch (error) {
      this.options.relaySend(
        serializeControl({
          type: "device_preview_input_ack",
          leaseId: msg.leaseId,
          inputSeq: msg.inputSeq,
          success: false,
          ...requestError(error),
        }),
      );
    }
  }
}
