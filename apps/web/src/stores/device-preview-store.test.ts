import { beforeEach, describe, expect, it } from "vitest";
import type {
  DevicePreviewCapability,
  DevicePreviewSummary,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";
import { createPreviewScope, type PreviewScope } from "@/services/preview-scope";
import { selectDevicePreviews, useDevicePreviewStore } from "./device-preview-store";

const capability: DevicePreviewCapability = {
  ios: { supported: true, available: true, interactive: true, command: "baguette" },
  android: { supported: true, available: true, interactive: true, command: "adb" },
};

function scope(bindingId: string, proxyId = "proxy-a"): PreviewScope {
  return createPreviewScope(proxyId, bindingId);
}

function preview(previewId: string, state: DevicePreviewSummary["state"]): DevicePreviewSummary {
  const common = {
    previewId,
    name: "iPhone 17 Pro",
    platform: "ios" as const,
    targetId: "00000000-0000-0000-0000-000000000001",
    model: "iPhone 17 Pro",
    osVersion: "26.4",
    interactive: true,
    createdAt: 1,
    updatedAt: 2,
  };
  return { ...common, state };
}

function target(targetId: string): DevicePreviewTarget {
  return {
    targetId,
    platform: "ios",
    name: targetId,
    model: "iPhone 17 Pro",
    osVersion: "26.4",
    interactive: true,
  };
}

describe("device-preview-store", () => {
  beforeEach(() => useDevicePreviewStore.getState().clear());

  it("accepts only versioned snapshots and ordered events for the active scope", () => {
    const activeScope = scope("binding-a-1");
    const store = useDevicePreviewStore.getState();
    store.activateScope(activeScope);

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "device-epoch",
        revision: 1,
        previews: [preview("one", "disconnected")],
      }),
    ).toMatchObject({ status: "applied", reason: "snapshot" });
    expect(
      store.applyPreviewState(activeScope, preview("one", "ready"), "device-epoch", 2),
    ).toMatchObject({ status: "applied", reason: "event" });
    expect(store.applyPreviewRemoved(activeScope, "one", "device-epoch", 3)).toMatchObject({
      status: "applied",
      reason: "event",
    });

    expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
      scope: activeScope,
      syncStatus: "synchronized",
      epoch: "device-epoch",
      revision: 3,
      previews: [],
    });
  });

  it("ignores stale versions and accepts a complete replacement epoch", () => {
    const activeScope = scope("binding-a-1");
    const store = useDevicePreviewStore.getState();
    store.activateScope(activeScope);
    store.replaceSnapshot(activeScope, {
      epoch: "old",
      revision: 3,
      previews: [preview("current", "ready")],
    });

    expect(store.applyPreviewState(activeScope, preview("stale", "ready"), "old", 2)).toMatchObject(
      { status: "ignored", reason: "stale-revision" },
    );
    expect(
      selectDevicePreviews(useDevicePreviewStore.getState()).map((item) => item.previewId),
    ).toEqual(["current"]);

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "new",
        revision: 0,
        previews: [preview("restarted", "disconnected")],
      }),
    ).toMatchObject({ status: "applied", reason: "epoch-replaced" });
    expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
      epoch: "new",
      revision: 0,
      previews: [expect.objectContaining({ previewId: "restarted" })],
    });
  });

  it("finishes list loading when a current snapshot repeats the authoritative revision", () => {
    const activeScope = scope("binding-a-1");
    const store = useDevicePreviewStore.getState();
    store.activateScope(activeScope);
    store.replaceSnapshot(activeScope, {
      epoch: "device-epoch",
      revision: 1,
      previews: [preview("one", "ready")],
    });
    store.markListLoading(activeScope);

    expect(useDevicePreviewStore.getState().listLoaded).toBe(false);
    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "device-epoch",
        revision: 1,
        previews: [preview("one", "ready")],
      }),
    ).toMatchObject({ status: "ignored", reason: "duplicate-revision" });
    expect(useDevicePreviewStore.getState()).toMatchObject({
      listLoaded: true,
      authoritative: {
        epoch: "device-epoch",
        revision: 1,
        previews: [expect.objectContaining({ previewId: "one" })],
      },
    });
  });

  it("scopes capability loading and error state without discarding the last result", () => {
    const activeScope = scope("binding-a-1");
    const staleScope = scope("binding-old");
    const store = useDevicePreviewStore.getState();
    store.activateScope(activeScope);
    store.setCapability(activeScope, capability);

    store.setCapabilityLoading(activeScope);
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capability,
      capabilityStatus: "loading",
      capabilityError: null,
    });

    store.setCapabilityError(activeScope, "capability probe failed");
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capability,
      capabilityStatus: "error",
      capabilityError: "capability probe failed",
    });

    store.setCapabilityLoading(staleScope);
    store.setCapabilityError(staleScope, "stale error");
    expect(useDevicePreviewStore.getState()).toMatchObject({
      capability,
      capabilityStatus: "error",
      capabilityError: "capability probe failed",
    });
  });

  it("rejects old snapshot, event, target, and capability results after A -> B -> A rebinding", () => {
    const oldAScope = scope("binding-a-1");
    const bScope = scope("binding-b-1", "proxy-b");
    const currentAScope = scope("binding-a-2");
    const store = useDevicePreviewStore.getState();

    store.activateScope(oldAScope);
    store.replaceSnapshot(oldAScope, {
      epoch: "old-a",
      revision: 1,
      previews: [preview("old-a", "ready")],
    });
    store.activateScope(bScope);
    store.replaceSnapshot(bScope, {
      epoch: "epoch-b",
      revision: 1,
      previews: [preview("current-b", "ready")],
    });
    store.activateScope(currentAScope);
    store.replaceSnapshot(currentAScope, {
      epoch: "current-a",
      revision: 4,
      previews: [preview("current-a", "ready")],
    });
    store.setTargets(currentAScope, [target("current-target")]);
    store.setCapability(currentAScope, capability);

    expect(
      store.replaceSnapshot(oldAScope, {
        epoch: "stale-a",
        revision: 99,
        previews: [preview("stale-snapshot", "ready")],
      }),
    ).toMatchObject({ status: "ignored", reason: "scope-mismatch" });
    expect(
      store.applyPreviewState(oldAScope, preview("stale-event", "ready"), "current-a", 5),
    ).toMatchObject({ status: "ignored", reason: "scope-mismatch" });
    store.setTargets(oldAScope, [target("stale-target")]);
    store.setCapability(oldAScope, {
      ios: { supported: false, available: false, interactive: false, error: "unsupported" },
      android: { supported: false, available: false, interactive: false, error: "unsupported" },
    });

    expect(useDevicePreviewStore.getState()).toMatchObject({
      capability,
      targets: [expect.objectContaining({ targetId: "current-target" })],
      authoritative: {
        scope: currentAScope,
        epoch: "current-a",
        revision: 4,
        previews: [expect.objectContaining({ previewId: "current-a" })],
      },
    });
  });

  it("requires scope activation and an initial snapshot before accepting events", () => {
    const activeScope = scope("binding-a-1");
    const store = useDevicePreviewStore.getState();

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "device-epoch",
        revision: 0,
        previews: [preview("unbound", "ready")],
      }),
    ).toBeNull();

    store.activateScope(activeScope);
    expect(
      store.applyPreviewState(activeScope, preview("partial", "ready"), "device-epoch", 1),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });
    expect(useDevicePreviewStore.getState().authoritative).toMatchObject({
      scope: activeScope,
      syncStatus: "needs-resync",
      epoch: null,
      revision: -1,
      previews: [],
    });
  });
});
