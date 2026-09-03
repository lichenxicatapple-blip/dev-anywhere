import type { DevicePreviewSummary } from "@dev-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewScope, type PreviewScope } from "@/services/preview-scope";
import { previewController } from "@/services/preview-controller";
import { selectDevicePreviews, useDevicePreviewStore } from "@/stores/device-preview-store";
import { selectWebPreviews, usePreviewStore } from "@/stores/preview-store";
import type { RelayClient } from "./relay-client";

const { toastSuccess, toastError, copyText } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@/lib/copy-text", () => ({ copyText }));

import { dispatchPreviewMessage } from "./preview-dispatcher";

const readyPreview = {
  previewId: "preview-1",
  name: "localhost:5173",
  source: { kind: "local" as const, url: "http://localhost:5173/" },
  state: "ready" as const,
  tunnelProvider: "cloudflare" as const,
  publicUrl: "https://example.trycloudflare.com/",
  createdAt: 10,
  updatedAt: 20,
};

const startingPreview = {
  previewId: readyPreview.previewId,
  name: readyPreview.name,
  source: readyPreview.source,
  state: "starting" as const,
  tunnelProvider: readyPreview.tunnelProvider,
  createdAt: readyPreview.createdAt,
  updatedAt: 10,
};

const readyDevicePreview: DevicePreviewSummary = {
  previewId: "device-preview-one",
  name: "Pixel 9",
  platform: "android",
  targetId: "emulator-5554",
  model: "Pixel 9",
  osVersion: "15",
  state: "ready",
  interactive: true,
  createdAt: 1,
  updatedAt: 2,
};

function relayForScope(scope: PreviewScope): RelayClient {
  return {
    getPreviewScope: () => scope,
    requestWebPreviewList: vi.fn(),
    requestDevicePreviewList: vi.fn(),
  } as unknown as RelayClient;
}

describe("preview-dispatcher", () => {
  let scope: PreviewScope;
  let relay: RelayClient;

  beforeEach(() => {
    previewController.dispose();
    scope = createPreviewScope("proxy-a", "binding-a");
    relay = relayForScope(scope);
    previewController.activate(relay, scope);
    usePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "web-epoch",
      revision: 0,
      previews: [startingPreview],
    });
    useDevicePreviewStore.getState().replaceSnapshot(scope, {
      epoch: "device-epoch",
      revision: 0,
      previews: [],
    });
    toastSuccess.mockReset();
    toastError.mockReset();
    copyText.mockReset();
    copyText.mockResolvedValue("clipboard");
  });

  afterEach(() => previewController.dispose());

  it("routes web pushes through the active controller and exposes a working copy action", async () => {
    dispatchPreviewMessage(relay, {
      type: "preview_state_push",
      scope,
      epoch: "web-epoch",
      revision: 1,
      preview: readyPreview,
    });

    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([readyPreview]);
    expect(toastSuccess).toHaveBeenCalledOnce();

    const options = toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } };
    expect(options.action.onClick).toEqual(expect.any(Function));
    options.action.onClick();
    await vi.waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(readyPreview.publicUrl, {
        allowUserGestureFallback: true,
      }),
    );
  });

  it("routes device state and removal pushes through the same dispatcher", () => {
    dispatchPreviewMessage(relay, {
      type: "device_preview_state_push",
      scope,
      epoch: "device-epoch",
      revision: 1,
      preview: readyDevicePreview,
    });
    expect(selectDevicePreviews(useDevicePreviewStore.getState())).toEqual([readyDevicePreview]);

    dispatchPreviewMessage(relay, {
      type: "device_preview_removed_push",
      scope,
      epoch: "device-epoch",
      revision: 2,
      previewId: readyDevicePreview.previewId,
    });
    expect(selectDevicePreviews(useDevicePreviewStore.getState())).toEqual([]);
  });

  it("drops pushes delivered by a stale Relay binding", () => {
    const staleRelay = relay;
    const currentScope = createPreviewScope("proxy-b", "binding-b");
    const currentRelay = relayForScope(currentScope);
    previewController.activate(currentRelay, currentScope);
    usePreviewStore.getState().replaceSnapshot(currentScope, {
      epoch: "current-epoch",
      revision: 0,
      previews: [],
    });

    dispatchPreviewMessage(staleRelay, {
      type: "preview_state_push",
      scope,
      epoch: "web-epoch",
      revision: 1,
      preview: readyPreview,
    });

    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
