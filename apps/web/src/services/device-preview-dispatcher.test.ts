import { beforeEach, describe, expect, it } from "vitest";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import { dispatchDevicePreviewMessage } from "./device-preview-dispatcher";
import type { DevicePreviewSummary } from "@dev-anywhere/shared";

const readyPreview: DevicePreviewSummary = {
  previewId: "device-preview-one",
  name: "Pixel 9",
  platform: "android",
  targetId: "emulator-5554",
  targetName: "Pixel 9",
  state: "ready",
  interactive: true,
  createdAt: 1,
  updatedAt: 2,
};

describe("device-preview-dispatcher", () => {
  beforeEach(() => useDevicePreviewStore.getState().clear());

  it("applies state and removal pushes in revision order", () => {
    dispatchDevicePreviewMessage({
      type: "device_preview_state_push",
      epoch: "epoch-one",
      revision: 1,
      preview: readyPreview,
    });
    expect(useDevicePreviewStore.getState().previews).toEqual([readyPreview]);

    dispatchDevicePreviewMessage({
      type: "device_preview_removed_push",
      epoch: "epoch-one",
      revision: 2,
      previewId: readyPreview.previewId,
    });
    expect(useDevicePreviewStore.getState().previews).toEqual([]);
  });
});
