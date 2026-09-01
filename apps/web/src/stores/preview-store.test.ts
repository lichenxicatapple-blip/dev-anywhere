import { beforeEach, describe, expect, it } from "vitest";
import type { PreviewSummary } from "@dev-anywhere/shared";
import { usePreviewStore } from "./preview-store";

function preview(previewId: string, state: PreviewSummary["state"] = "starting"): PreviewSummary {
  return {
    previewId,
    name: `Preview ${previewId}`,
    source: { kind: "local", url: "http://localhost:5173/" },
    state,
    tunnelProvider: "cloudflare",
    ...(state === "ready" ? { publicUrl: `https://${previewId}.trycloudflare.com/` } : {}),
    createdAt: 10,
    updatedAt: state === "starting" ? 10 : 20,
  };
}

describe("preview-store", () => {
  beforeEach(() => {
    usePreviewStore.getState().clear();
  });

  it("replaces snapshots by epoch/revision and ignores a stale snapshot", () => {
    usePreviewStore.getState().replaceSnapshot({
      epoch: "epoch-a",
      revision: 2,
      previews: [preview("a", "ready")],
    });
    usePreviewStore.getState().replaceSnapshot({
      epoch: "epoch-a",
      revision: 1,
      previews: [preview("stale")],
    });

    expect(usePreviewStore.getState().previews.map((item) => item.previewId)).toEqual(["a"]);

    usePreviewStore.getState().replaceSnapshot({
      epoch: "epoch-b",
      revision: 0,
      previews: [preview("restarted", "disconnected")],
    });
    expect(usePreviewStore.getState()).toMatchObject({
      epoch: "epoch-b",
      revision: 0,
      listLoaded: true,
      previews: [expect.objectContaining({ previewId: "restarted", state: "disconnected" })],
    });
  });

  it("does not downgrade a fast ready push when the create ACK adds its starting row", () => {
    usePreviewStore.getState().applyPreviewState(preview("fast", "ready"), "epoch-a", 1);
    usePreviewStore.getState().addStartingPreview(preview("fast", "starting"));

    expect(usePreviewStore.getState().previews).toEqual([preview("fast", "ready")]);
  });

  it("applies ordered state/removal pushes and ignores stale revisions", () => {
    usePreviewStore.getState().replaceSnapshot({
      epoch: "epoch-a",
      revision: 1,
      previews: [preview("a")],
    });
    usePreviewStore.getState().applyPreviewState(preview("a", "ready"), "epoch-a", 2);
    usePreviewStore.getState().applyPreviewRemoved("a", "epoch-a", 1);
    expect(usePreviewStore.getState().previews[0].state).toBe("ready");

    usePreviewStore.getState().applyPreviewRemoved("a", "epoch-a", 3);
    expect(usePreviewStore.getState().previews).toEqual([]);
  });

  it("clears all preview and capability state when switching proxies", () => {
    usePreviewStore.getState().replaceSnapshot({
      epoch: "epoch-a",
      revision: 1,
      previews: [preview("a")],
    });
    usePreviewStore.getState().setCapability({
      supported: true,
      cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
      cpolar: { available: false },
    });

    usePreviewStore.getState().prepareForProxySwitch();

    expect(usePreviewStore.getState()).toMatchObject({
      previews: [],
      listLoaded: false,
      epoch: null,
      revision: -1,
      capability: null,
      capabilityStatus: "idle",
    });
  });
});
