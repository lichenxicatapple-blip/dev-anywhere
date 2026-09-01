import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevicePreviewCapability, DevicePreviewSummary } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { useDevicePreviewStore } from "@/stores/device-preview-store";
import type { RelayClient } from "./relay-client";
import { syncDevicePreviewSnapshot } from "./device-preview-snapshot-loader";

const capability: DevicePreviewCapability = {
  supported: true,
  ios: { supported: true, available: true, interactive: true, command: "baguette" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

function preview(previewId: string): DevicePreviewSummary {
  return {
    previewId,
    name: previewId,
    platform: "ios",
    targetId: "00000000-0000-0000-0000-000000000001",
    targetName: "iPhone",
    state: "ready",
    interactive: true,
    createdAt: 1,
    updatedAt: 2,
  };
}

function relayWith(requestDevicePreviewList: ReturnType<typeof vi.fn>): RelayClient {
  return { requestDevicePreviewList } as unknown as RelayClient;
}

describe("syncDevicePreviewSnapshot", () => {
  beforeEach(() => {
    useAppStore.getState().setProxy("proxy-a", "Machine A");
    useDevicePreviewStore.getState().clear();
  });

  it("keeps the newest request when an earlier request for the same Proxy resolves last", async () => {
    let resolveOlder!: (snapshot: {
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }) => void;
    const olderRequest = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
    );
    const newerRequest = vi.fn().mockResolvedValue({
      epoch: "new-epoch",
      revision: 4,
      previews: [preview("new")],
    });

    syncDevicePreviewSnapshot(relayWith(olderRequest), "proxy-a", capability, "older");
    syncDevicePreviewSnapshot(relayWith(newerRequest), "proxy-a", capability, "newer");
    await vi.waitFor(() =>
      expect(useDevicePreviewStore.getState().previews[0]?.previewId).toBe("new"),
    );

    resolveOlder({ epoch: "old-epoch", revision: 99, previews: [preview("old")] });
    await Promise.resolve();

    expect(useDevicePreviewStore.getState()).toMatchObject({
      epoch: "new-epoch",
      revision: 4,
      previews: [expect.objectContaining({ previewId: "new" })],
    });
  });

  it("invalidates an in-flight list when the rebound Proxy does not support the protocol", async () => {
    let resolveSnapshot!: (snapshot: {
      epoch: string;
      revision: number;
      previews: DevicePreviewSummary[];
    }) => void;
    const request = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    syncDevicePreviewSnapshot(relayWith(request), "proxy-a", capability, "supported");
    syncDevicePreviewSnapshot(relayWith(vi.fn()), "proxy-a", undefined, "unsupported");
    resolveSnapshot({ epoch: "stale", revision: 10, previews: [preview("stale")] });
    await Promise.resolve();

    expect(useDevicePreviewStore.getState()).toMatchObject({
      capability: null,
      listLoaded: true,
      previews: [],
      epoch: null,
    });
  });
});
