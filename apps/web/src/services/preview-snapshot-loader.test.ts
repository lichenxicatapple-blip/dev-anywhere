import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPreviewCapability } from "@dev-anywhere/shared";
import { useAppStore } from "@/stores/app-store";
import { usePreviewStore } from "@/stores/preview-store";
import type { RelayClient } from "./relay-client";
import { syncWebPreviewSnapshot } from "./preview-snapshot-loader";

const capability: WebPreviewCapability = {
  supported: true,
  cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
  cpolar: { available: false },
};

function relayWith(requestWebPreviewList: ReturnType<typeof vi.fn>): RelayClient {
  return { requestWebPreviewList } as unknown as RelayClient;
}

describe("syncWebPreviewSnapshot", () => {
  beforeEach(() => {
    useAppStore.getState().setProxy("proxy-a", "Machine A");
    usePreviewStore.getState().clear();
  });

  it("treats an absent capability as an old Proxy without sending an unsupported request", () => {
    const requestWebPreviewList = vi.fn();

    syncWebPreviewSnapshot(relayWith(requestWebPreviewList), "proxy-a", undefined, "test");

    expect(requestWebPreviewList).not.toHaveBeenCalled();
    expect(usePreviewStore.getState()).toMatchObject({
      capability: null,
      capabilityStatus: "loaded",
      previews: [],
      listLoaded: true,
    });
  });

  it("loads the supported Proxy snapshot", async () => {
    const requestWebPreviewList = vi.fn().mockResolvedValue({
      epoch: "epoch-a",
      revision: 2,
      previews: [],
    });

    syncWebPreviewSnapshot(relayWith(requestWebPreviewList), "proxy-a", capability, "test");

    await vi.waitFor(() => {
      expect(usePreviewStore.getState()).toMatchObject({
        capability,
        listLoaded: true,
        epoch: "epoch-a",
        revision: 2,
      });
    });
  });

  it("drops a snapshot that resolves after the user switches to another Proxy", async () => {
    let resolveSnapshot: (snapshot: {
      epoch: string;
      revision: number;
      previews: [];
    }) => void = () => undefined;
    const requestWebPreviewList = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    syncWebPreviewSnapshot(relayWith(requestWebPreviewList), "proxy-a", capability, "test");

    useAppStore.getState().setProxy("proxy-b", "Machine B");
    usePreviewStore.getState().prepareForProxySwitch();
    resolveSnapshot({ epoch: "stale-epoch", revision: 9, previews: [] });

    await Promise.resolve();
    expect(usePreviewStore.getState()).toMatchObject({
      epoch: null,
      revision: -1,
      listLoaded: false,
    });
  });
});
