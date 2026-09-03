import { describe, expect, it } from "vitest";
import type { DevicePreviewSummary, PreviewSummary } from "@dev-anywhere/shared";
import {
  createVersionedPreviewState,
  reduceVersionedPreviewState,
} from "./versioned-preview-reducer";
import { createPreviewScope, type PreviewScope } from "./preview-scope";

function scope(proxyId = "proxy-a"): PreviewScope {
  return createPreviewScope(proxyId, `${proxyId}-binding`);
}

function webPreview(previewId: string, state: PreviewSummary["state"] = "ready"): PreviewSummary {
  const common = {
    previewId,
    name: previewId,
    source: { kind: "local" as const, url: "http://localhost:5173" },
    tunnelProvider: "cloudflare" as const,
    createdAt: 1,
    updatedAt: 2,
  };
  if (state === "ready") {
    return { ...common, state, publicUrl: `https://${previewId}.trycloudflare.com` };
  }
  if (state === "failed") return { ...common, state, error: "preview failed" };
  return { ...common, state };
}

function devicePreview(previewId: string): DevicePreviewSummary {
  return {
    previewId,
    name: previewId,
    platform: "ios",
    targetId: "target-1",
    model: "iPhone 17 Pro",
    osVersion: "26.4",
    state: "ready",
    interactive: true,
    createdAt: 1,
    updatedAt: 2,
  };
}

function snapshot<TEntity extends { previewId: string }>(
  targetScope: PreviewScope,
  epoch: string,
  revision: number,
  previews: readonly TEntity[],
) {
  return { kind: "snapshot" as const, scope: targetScope, epoch, revision, previews };
}

describe("versioned preview reducer", () => {
  it("accepts a complete Web Preview snapshot and ordered state/remove events", () => {
    const targetScope = scope();
    let result = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 4, [webPreview("one", "disconnected")]),
    );
    expect(result).toMatchObject({ status: "applied", reason: "snapshot" });

    result = reduceVersionedPreviewState(result.state, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 5,
      preview: webPreview("one", "ready"),
    });
    expect(result).toMatchObject({
      status: "applied",
      reason: "event",
      state: { revision: 5, previews: [expect.objectContaining({ state: "ready" })] },
    });

    result = reduceVersionedPreviewState(result.state, {
      kind: "removed",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 6,
      previewId: "one",
    });
    expect(result).toMatchObject({
      status: "applied",
      state: { revision: 6, previews: [] },
    });
  });

  it("is generic over Device Preview summaries", () => {
    const targetScope = scope();
    const result = reduceVersionedPreviewState(
      createVersionedPreviewState<DevicePreviewSummary>(targetScope),
      snapshot(targetScope, "device-epoch", 0, [devicePreview("device-one")]),
    );

    expect(result).toMatchObject({
      status: "applied",
      state: {
        previews: [expect.objectContaining({ previewId: "device-one", platform: "ios" })],
      },
    });
  });

  it("ignores duplicate and stale revisions in the same epoch", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 4, [webPreview("current")]),
    ).state;

    const duplicate = reduceVersionedPreviewState(current, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 4,
      preview: webPreview("duplicate"),
    });
    const stale = reduceVersionedPreviewState(current, {
      kind: "removed",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 3,
      previewId: "current",
    });

    expect(duplicate).toMatchObject({ status: "ignored", reason: "duplicate-revision" });
    expect(stale).toMatchObject({ status: "ignored", reason: "stale-revision" });
    expect(duplicate.state).toBe(current);
    expect(stale.state).toBe(current);
  });

  it("ignores duplicate and stale complete snapshots in the same epoch", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 4, [webPreview("current")]),
    ).state;

    const duplicate = reduceVersionedPreviewState(
      current,
      snapshot(targetScope, "epoch-a", 4, [webPreview("duplicate")]),
    );
    const stale = reduceVersionedPreviewState(
      current,
      snapshot(targetScope, "epoch-a", 3, [webPreview("stale")]),
    );

    expect(duplicate).toMatchObject({ status: "ignored", reason: "duplicate-revision" });
    expect(stale).toMatchObject({ status: "ignored", reason: "stale-revision" });
    expect(duplicate.state).toBe(current);
    expect(stale.state).toBe(current);
  });

  it("marks a revision gap as needing resync and does not partially apply later events", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 2, [webPreview("current")]),
    ).state;

    const gap = reduceVersionedPreviewState(current, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 5,
      preview: webPreview("missed"),
    });
    expect(gap).toMatchObject({
      status: "needs-resync",
      reason: "revision-gap",
      state: {
        syncStatus: "needs-resync",
        revision: 2,
        previews: [expect.objectContaining({ previewId: "current" })],
        resyncCause: { observedEpoch: "epoch-a", observedRevision: 5 },
      },
    });

    const later = reduceVersionedPreviewState(gap.state, {
      kind: "removed",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 6,
      previewId: "current",
    });
    expect(later).toMatchObject({
      status: "needs-resync",
      reason: "resync-pending",
      state: { revision: 2, resyncCause: { observedRevision: 6 } },
    });
  });

  it("requires a snapshot for an event from an unknown epoch", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 2, [webPreview("old")]),
    ).state;

    const unknown = reduceVersionedPreviewState(current, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-b",
      revision: 1,
      preview: webPreview("new"),
    });
    expect(unknown).toMatchObject({
      status: "needs-resync",
      reason: "unknown-epoch",
      state: {
        epoch: "epoch-a",
        revision: 2,
        previews: [expect.objectContaining({ previewId: "old" })],
      },
    });

    const recovered = reduceVersionedPreviewState(
      unknown.state,
      snapshot(targetScope, "epoch-b", 1, [webPreview("new")]),
    );
    expect(recovered).toMatchObject({
      status: "applied",
      reason: "epoch-replaced",
      state: { syncStatus: "synchronized", epoch: "epoch-b", revision: 1 },
    });
  });

  it("does not let a snapshot older than the observed gap claim recovery", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 2, [webPreview("current")]),
    ).state;
    const gap = reduceVersionedPreviewState(current, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 5,
      preview: webPreview("future"),
    });

    const staleSnapshot = reduceVersionedPreviewState(
      gap.state,
      snapshot(targetScope, "epoch-a", 4, [webPreview("incomplete")]),
    );
    expect(staleSnapshot).toMatchObject({
      status: "needs-resync",
      reason: "resync-pending",
    });
    expect(staleSnapshot.state).toBe(gap.state);
  });

  it("accepts a complete replacement epoch while resync is pending", () => {
    const targetScope = scope();
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-a", 2, [webPreview("current")]),
    ).state;
    const gap = reduceVersionedPreviewState(current, {
      kind: "state",
      scope: targetScope,
      epoch: "epoch-a",
      revision: 5,
      preview: webPreview("future"),
    });

    const replacement = reduceVersionedPreviewState(
      gap.state,
      snapshot(targetScope, "epoch-b", 0, [webPreview("restarted")]),
    );
    expect(replacement).toMatchObject({
      status: "applied",
      reason: "epoch-replaced",
      state: {
        syncStatus: "synchronized",
        epoch: "epoch-b",
        revision: 0,
        previews: [expect.objectContaining({ previewId: "restarted" })],
      },
    });
  });

  it("accepts a complete snapshot from a replacement epoch", () => {
    const targetScope = scope();
    const oldState = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      snapshot(targetScope, "epoch-old", 99, [webPreview("old")]),
    ).state;
    const replacement = reduceVersionedPreviewState(
      oldState,
      snapshot(targetScope, "epoch-new", 0, [webPreview("new")]),
    );

    expect(replacement).toMatchObject({
      status: "applied",
      reason: "epoch-replaced",
      state: { epoch: "epoch-new", revision: 0 },
    });
  });

  it("ignores every input from another PreviewScope, including A -> B -> A rebinding", () => {
    const currentScope = createPreviewScope("proxy-a", "binding-a-1");
    const reboundScope = createPreviewScope("proxy-a", "binding-a-2");
    const current = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(currentScope),
      snapshot(currentScope, "epoch-a", 1, [webPreview("current")]),
    ).state;

    const result = reduceVersionedPreviewState(
      current,
      snapshot(reboundScope, "epoch-a", 2, [webPreview("wrong-binding")]),
    );
    expect(result).toMatchObject({ status: "ignored", reason: "scope-mismatch" });
    expect(result.state).toBe(current);
  });

  it("requires an initial snapshot instead of building a partial list from a push", () => {
    const targetScope = scope();
    const result = reduceVersionedPreviewState(
      createVersionedPreviewState<PreviewSummary>(targetScope),
      {
        kind: "state",
        scope: targetScope,
        epoch: "epoch-a",
        revision: 1,
        preview: webPreview("partial"),
      },
    );

    expect(result).toMatchObject({
      status: "needs-resync",
      reason: "unknown-epoch",
      state: { syncStatus: "needs-resync", epoch: null, revision: -1, previews: [] },
    });
  });
});
