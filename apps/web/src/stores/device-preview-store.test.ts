import { beforeEach, describe, expect, it } from "vitest";
import { useDevicePreviewStore } from "./device-preview-store";
import type { DevicePreviewSummary } from "@/types/device-preview";

function preview(previewId: string, state: DevicePreviewSummary["state"]): DevicePreviewSummary {
  return {
    previewId,
    name: "iPhone 17 Pro",
    platform: "ios",
    targetId: "00000000-0000-0000-0000-000000000001",
    targetName: "iPhone 17 Pro",
    state,
    interactive: true,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("device-preview-store", () => {
  beforeEach(() => useDevicePreviewStore.getState().clear());

  it("does not let an optimistic create overwrite an earlier ready push", () => {
    const store = useDevicePreviewStore.getState();
    store.applyPreviewState(preview("one", "ready"), "epoch", 1);
    store.addStartingPreview(preview("one", "starting"));
    expect(useDevicePreviewStore.getState().previews[0]?.state).toBe("ready");
  });

  it("ignores stale revisions and resets on a new manager epoch", () => {
    const store = useDevicePreviewStore.getState();
    store.replaceSnapshot({ epoch: "old", revision: 3, previews: [preview("old", "ready")] });
    store.applyPreviewState(preview("stale", "ready"), "old", 2);
    expect(useDevicePreviewStore.getState().previews.map((item) => item.previewId)).toEqual([
      "old",
    ]);

    store.applyPreviewState(preview("new", "ready"), "new", 1);
    expect(useDevicePreviewStore.getState().previews.map((item) => item.previewId)).toEqual([
      "new",
    ]);
  });

  it("does not roll back an authoritative push after an optimistic mutation fails", () => {
    const store = useDevicePreviewStore.getState();
    store.addStartingPreview(preview("one", "disconnected"));
    store.setPreviewState("one", "starting");
    store.applyPreviewState(preview("one", "ready"), "epoch", 1);

    store.setPreviewStateIf("one", "starting", "disconnected");

    expect(useDevicePreviewStore.getState().previews[0]?.state).toBe("ready");
  });
});
