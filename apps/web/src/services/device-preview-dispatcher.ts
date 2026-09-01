import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { registerDispatcher } from "./dispatcher-registry";
import type { InboundMessage } from "./relay-client";

export function dispatchDevicePreviewMessage(msg: InboundMessage): void {
  const store = useDevicePreviewStore.getState();
  switch (msg.type) {
    case "device_preview_state_push":
      store.applyPreviewState(msg.preview, msg.epoch, msg.revision);
      break;
    case "device_preview_removed_push":
      store.applyPreviewRemoved(msg.previewId, msg.epoch, msg.revision);
      break;
    default:
      break;
  }
}

export function registerDevicePreviewDispatcher(): () => void {
  return registerDispatcher("registerDevicePreviewDispatcher", () => dispatchDevicePreviewMessage);
}
