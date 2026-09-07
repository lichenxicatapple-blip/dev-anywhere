import type { PreviewControlRequest } from "../../ipc/preview-worker-protocol.js";
import type { RelaySend } from "../relay-router-types.js";
import type { PreviewManager } from "./preview-manager.js";
import type { DevicePreviewManager } from "../device-preview/device-preview-manager.js";
import { RelayPreviewHandlers } from "./relay-preview-handlers.js";
import { RelayDevicePreviewHandlers } from "../device-preview/relay-device-preview-handlers.js";
import { PreviewOperationJournal } from "./preview-operation-journal.js";

/** Both preview kinds share one command journal and one process lifetime. */
export class PreviewControlRouter {
  private readonly web: RelayPreviewHandlers;
  private readonly device: RelayDevicePreviewHandlers;

  constructor(
    private readonly options: {
      relaySend: RelaySend;
      previewManager: PreviewManager;
      devicePreviewManager: DevicePreviewManager;
    },
    private readonly journal = new PreviewOperationJournal(),
  ) {
    this.web = new RelayPreviewHandlers({ ...options, operationJournal: this.journal });
    this.device = new RelayDevicePreviewHandlers({
      relaySend: options.relaySend,
      manager: options.devicePreviewManager,
      operationJournal: this.journal,
    });
  }

  bindReply(relaySend: RelaySend): PreviewControlRouter {
    return new PreviewControlRouter({ ...this.options, relaySend }, this.journal);
  }

  handle(message: PreviewControlRequest): void | Promise<void> {
    switch (message.type) {
      case "preview_capability_request":
        return this.web.onCapability(message);
      case "preview_static_inspect_request":
        return this.web.onStaticInspect(message);
      case "preview_create_request":
        return this.web.onCreate(message);
      case "preview_list_request":
        return this.web.onList(message);
      case "preview_rename_request":
        return this.web.onRename(message);
      case "preview_reconnect_request":
        return this.web.onReconnect(message);
      case "preview_close_request":
        return this.web.onClose(message);
      case "device_preview_capability_request":
        return this.device.onCapability(message);
      case "device_preview_targets_request":
        return this.device.onTargets(message);
      case "device_preview_create_request":
        return this.device.onCreate(message);
      case "device_preview_list_request":
        return this.device.onList(message);
      case "device_preview_rename_request":
        return this.device.onRename(message);
      case "device_preview_reconnect_request":
        return this.device.onReconnect(message);
      case "device_preview_close_request":
        return this.device.onClose(message);
      case "device_preview_stream_start":
        return this.device.onStreamStart(message);
      case "device_preview_stream_stop":
        return this.device.onStreamStop(message);
      case "device_preview_input_revoke":
        return this.device.onInputRevoke(message);
      case "device_preview_input":
        return this.device.onInput(message);
    }
  }
}
