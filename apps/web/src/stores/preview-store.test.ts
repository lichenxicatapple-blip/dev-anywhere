import { beforeEach, describe, expect, it } from "vitest";
import type { PreviewSummary } from "@dev-anywhere/shared";
import { createPreviewScope, type PreviewScope } from "@/services/preview-scope";
import { selectWebPreviews, usePreviewStore } from "./preview-store";

function scope(bindingId: string, proxyId = "proxy-a"): PreviewScope {
  return createPreviewScope(proxyId, bindingId);
}

function preview(previewId: string, state: PreviewSummary["state"] = "starting"): PreviewSummary {
  const common = {
    previewId,
    name: `Preview ${previewId}`,
    source: { kind: "local" as const, url: "http://localhost:5173/" },
    tunnelProvider: "cloudflare" as const,
    createdAt: 10,
    updatedAt: state === "starting" ? 10 : 20,
  };
  if (state === "ready") {
    return { ...common, state, publicUrl: `https://${previewId}.trycloudflare.com/` };
  }
  if (state === "failed") return { ...common, state, error: "preview failed" };
  return { ...common, state };
}

describe("preview-store", () => {
  beforeEach(() => {
    usePreviewStore.getState().clear();
  });

  it("accepts only versioned snapshots and ordered events for the active scope", () => {
    const activeScope = scope("binding-a-1");
    const store = usePreviewStore.getState();
    store.activateScope(activeScope);

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "epoch-a",
        revision: 1,
        previews: [preview("one")],
      }),
    ).toMatchObject({ status: "applied", reason: "snapshot" });
    expect(
      store.applyPreviewState(activeScope, preview("one", "ready"), "epoch-a", 2),
    ).toMatchObject({ status: "applied", reason: "event" });
    expect(store.applyPreviewRemoved(activeScope, "one", "epoch-a", 3)).toMatchObject({
      status: "applied",
      reason: "event",
    });

    expect(usePreviewStore.getState().authoritative).toMatchObject({
      scope: activeScope,
      syncStatus: "synchronized",
      epoch: "epoch-a",
      revision: 3,
      previews: [],
    });
  });

  it("ignores stale versions in one epoch and accepts a replacement epoch snapshot", () => {
    const activeScope = scope("binding-a-1");
    const store = usePreviewStore.getState();
    store.activateScope(activeScope);
    store.replaceSnapshot(activeScope, {
      epoch: "epoch-a",
      revision: 2,
      previews: [preview("current", "ready")],
    });

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "epoch-a",
        revision: 1,
        previews: [preview("stale")],
      }),
    ).toMatchObject({ status: "ignored", reason: "stale-revision" });
    expect(store.applyPreviewRemoved(activeScope, "current", "epoch-a", 1)).toMatchObject({
      status: "ignored",
      reason: "stale-revision",
    });
    expect(selectWebPreviews(usePreviewStore.getState()).map((item) => item.previewId)).toEqual([
      "current",
    ]);

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "epoch-b",
        revision: 0,
        previews: [preview("restarted", "disconnected")],
      }),
    ).toMatchObject({ status: "applied", reason: "epoch-replaced" });
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      epoch: "epoch-b",
      revision: 0,
      previews: [expect.objectContaining({ previewId: "restarted", state: "disconnected" })],
    });
  });

  it("finishes list loading when a current snapshot repeats the authoritative revision", () => {
    const activeScope = scope("binding-a-1");
    const store = usePreviewStore.getState();
    store.activateScope(activeScope);
    store.replaceSnapshot(activeScope, {
      epoch: "epoch-a",
      revision: 1,
      previews: [preview("one", "ready")],
    });
    store.markListLoading(activeScope);

    expect(usePreviewStore.getState().listLoaded).toBe(false);
    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "epoch-a",
        revision: 1,
        previews: [preview("one", "ready")],
      }),
    ).toMatchObject({ status: "ignored", reason: "duplicate-revision" });
    expect(usePreviewStore.getState()).toMatchObject({
      listLoaded: true,
      authoritative: {
        epoch: "epoch-a",
        revision: 1,
        previews: [expect.objectContaining({ previewId: "one" })],
      },
    });
  });

  it("rejects old snapshots, events, and capability results after A -> B -> A rebinding", () => {
    const oldAScope = scope("binding-a-1");
    const bScope = scope("binding-b-1", "proxy-b");
    const currentAScope = scope("binding-a-2");
    const store = usePreviewStore.getState();

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
    store.setCapability(oldAScope, {
      cloudflared: { available: false, error: "unavailable" },
      cpolar: { available: false, error: "unavailable" },
    });

    expect(usePreviewStore.getState()).toMatchObject({
      capability: null,
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
    const store = usePreviewStore.getState();

    expect(
      store.replaceSnapshot(activeScope, {
        epoch: "epoch-a",
        revision: 0,
        previews: [preview("unbound")],
      }),
    ).toBeNull();

    store.activateScope(activeScope);
    expect(
      store.applyPreviewState(activeScope, preview("partial", "ready"), "epoch-a", 1),
    ).toMatchObject({ status: "needs-resync", reason: "unknown-epoch" });
    expect(usePreviewStore.getState().authoritative).toMatchObject({
      scope: activeScope,
      syncStatus: "needs-resync",
      epoch: null,
      revision: -1,
      previews: [],
    });
  });

  it("clears the complete scoped state", () => {
    const activeScope = scope("binding-a-1");
    const store = usePreviewStore.getState();
    store.activateScope(activeScope);
    store.replaceSnapshot(activeScope, {
      epoch: "epoch-a",
      revision: 1,
      previews: [preview("one")],
    });
    store.setCapability(activeScope, {
      cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
      cpolar: { available: false, error: "unavailable" },
    });

    store.clear();

    expect(usePreviewStore.getState()).toMatchObject({
      authoritative: null,
      listLoaded: false,
      capability: null,
      capabilityStatus: "idle",
    });
    expect(selectWebPreviews(usePreviewStore.getState())).toEqual([]);
  });
});
