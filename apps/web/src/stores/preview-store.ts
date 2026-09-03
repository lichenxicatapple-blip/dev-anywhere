import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  WebPreviewCapability,
  WebPreviewSnapshot,
  WebPreviewSummary,
} from "@/types/web-preview";
import { samePreviewScope, type PreviewScope } from "@/services/preview-scope";
import {
  createVersionedPreviewState,
  reduceVersionedPreviewState,
  type VersionedPreviewReduceResult,
  type VersionedPreviewState,
} from "@/services/versioned-preview-reducer";

type PreviewCapabilityStatus = "idle" | "loading" | "loaded" | "error";
type WebPreviewReduceResult = VersionedPreviewReduceResult<WebPreviewSummary>;

interface PreviewStoreState {
  authoritative: VersionedPreviewState<WebPreviewSummary> | null;
  listLoaded: boolean;
  capability: WebPreviewCapability | null;
  capabilityStatus: PreviewCapabilityStatus;
  capabilityError: string | null;

  activateScope: (scope: PreviewScope) => void;
  replaceSnapshot: (
    scope: PreviewScope,
    snapshot: WebPreviewSnapshot,
  ) => WebPreviewReduceResult | null;
  applyPreviewState: (
    scope: PreviewScope,
    preview: WebPreviewSummary,
    epoch: string,
    revision: number,
  ) => WebPreviewReduceResult | null;
  applyPreviewRemoved: (
    scope: PreviewScope,
    previewId: string,
    epoch: string,
    revision: number,
  ) => WebPreviewReduceResult | null;
  setCapabilityLoading: (scope: PreviewScope) => void;
  setCapability: (scope: PreviewScope, capability: WebPreviewCapability) => void;
  setCapabilityError: (scope: PreviewScope, error: string) => void;
  markListLoading: (scope: PreviewScope) => void;
  clear: () => void;
}

const emptyPreviewState = {
  authoritative: null as VersionedPreviewState<WebPreviewSummary> | null,
  listLoaded: false,
  capability: null as WebPreviewCapability | null,
  capabilityStatus: "idle" as PreviewCapabilityStatus,
  capabilityError: null as string | null,
};

function reduceAuthoritative(
  set: (partial: Partial<PreviewStoreState>) => void,
  get: () => PreviewStoreState,
  input:
    | {
        kind: "snapshot";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        previews: readonly WebPreviewSummary[];
      }
    | {
        kind: "state";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        preview: WebPreviewSummary;
      }
    | {
        kind: "removed";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        previewId: string;
      },
): WebPreviewReduceResult | null {
  const current = get().authoritative;
  if (!current) return null;
  const result = reduceVersionedPreviewState(current, input);
  const snapshotCompleted =
    input.kind === "snapshot" && samePreviewScope(current.scope, input.scope);
  if (result.state !== current || (snapshotCompleted && !get().listLoaded)) {
    set({
      authoritative: result.state,
      ...(snapshotCompleted ? { listLoaded: true } : {}),
    });
  }
  return result;
}

export const selectWebPreviews = (state: PreviewStoreState): readonly WebPreviewSummary[] =>
  state.authoritative?.previews ?? [];

export const usePreviewStore = create<PreviewStoreState>()(
  devtools(
    (set, get) => ({
      ...emptyPreviewState,

      activateScope: (scope) =>
        set({
          ...emptyPreviewState,
          authoritative: createVersionedPreviewState<WebPreviewSummary>(scope),
        }),
      replaceSnapshot: (scope, snapshot) =>
        reduceAuthoritative(set, get, {
          kind: "snapshot",
          scope,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          previews: snapshot.previews,
        }),
      applyPreviewState: (scope, preview, epoch, revision) =>
        reduceAuthoritative(set, get, {
          kind: "state",
          scope,
          epoch,
          revision,
          preview,
        }),
      applyPreviewRemoved: (scope, previewId, epoch, revision) =>
        reduceAuthoritative(set, get, {
          kind: "removed",
          scope,
          epoch,
          revision,
          previewId,
        }),
      setCapabilityLoading: (scope) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ capabilityStatus: "loading", capabilityError: null });
      },
      setCapability: (scope, capability) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ capability, capabilityStatus: "loaded", capabilityError: null });
      },
      setCapabilityError: (scope, capabilityError) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ capabilityStatus: "error", capabilityError });
      },
      markListLoading: (scope) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ listLoaded: false });
      },
      clear: () => set({ ...emptyPreviewState }),
    }),
    { name: "preview-store" },
  ),
);
