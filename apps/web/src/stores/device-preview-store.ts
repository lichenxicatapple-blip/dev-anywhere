import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  DevicePreviewCapability,
  DevicePreviewSnapshot,
  DevicePreviewSummary,
  DevicePreviewTarget,
} from "@/types/device-preview";
import { samePreviewScope, type PreviewScope } from "@/services/preview-scope";
import {
  createVersionedPreviewState,
  reduceVersionedPreviewState,
  type VersionedPreviewReduceResult,
  type VersionedPreviewState,
} from "@/services/versioned-preview-reducer";

type LoadStatus = "idle" | "loading" | "loaded" | "error";
type DevicePreviewReduceResult = VersionedPreviewReduceResult<DevicePreviewSummary>;

interface DevicePreviewStoreState {
  authoritative: VersionedPreviewState<DevicePreviewSummary> | null;
  targets: DevicePreviewTarget[];
  capability: DevicePreviewCapability | null;
  capabilityStatus: LoadStatus;
  capabilityError: string | null;
  targetsStatus: LoadStatus;
  targetsError: string | null;
  listLoaded: boolean;

  activateScope: (scope: PreviewScope) => void;
  replaceSnapshot: (
    scope: PreviewScope,
    snapshot: DevicePreviewSnapshot,
  ) => DevicePreviewReduceResult | null;
  applyPreviewState: (
    scope: PreviewScope,
    preview: DevicePreviewSummary,
    epoch: string,
    revision: number,
  ) => DevicePreviewReduceResult | null;
  applyPreviewRemoved: (
    scope: PreviewScope,
    previewId: string,
    epoch: string,
    revision: number,
  ) => DevicePreviewReduceResult | null;
  setCapabilityLoading: (scope: PreviewScope) => void;
  setCapability: (scope: PreviewScope, capability: DevicePreviewCapability) => void;
  setCapabilityError: (scope: PreviewScope, error: string) => void;
  setTargetsLoading: (scope: PreviewScope) => void;
  setTargets: (scope: PreviewScope, targets: DevicePreviewTarget[]) => void;
  setTargetsError: (scope: PreviewScope, error: string) => void;
  markListLoading: (scope: PreviewScope) => void;
  clear: () => void;
}

const emptyState = {
  authoritative: null as VersionedPreviewState<DevicePreviewSummary> | null,
  targets: [] as DevicePreviewTarget[],
  capability: null as DevicePreviewCapability | null,
  capabilityStatus: "idle" as LoadStatus,
  capabilityError: null as string | null,
  targetsStatus: "idle" as LoadStatus,
  targetsError: null as string | null,
  listLoaded: false,
};

function reduceAuthoritative(
  set: (partial: Partial<DevicePreviewStoreState>) => void,
  get: () => DevicePreviewStoreState,
  input:
    | {
        kind: "snapshot";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        previews: readonly DevicePreviewSummary[];
      }
    | {
        kind: "state";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        preview: DevicePreviewSummary;
      }
    | {
        kind: "removed";
        scope: PreviewScope;
        epoch: string;
        revision: number;
        previewId: string;
      },
): DevicePreviewReduceResult | null {
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

export const selectDevicePreviews = (
  state: DevicePreviewStoreState,
): readonly DevicePreviewSummary[] => state.authoritative?.previews ?? [];

export const useDevicePreviewStore = create<DevicePreviewStoreState>()(
  devtools(
    (set, get) => ({
      ...emptyState,
      activateScope: (scope) =>
        set({
          ...emptyState,
          authoritative: createVersionedPreviewState<DevicePreviewSummary>(scope),
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
      setTargetsLoading: (scope) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ targetsStatus: "loading", targetsError: null });
      },
      setTargets: (scope, targets) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ targets, targetsStatus: "loaded", targetsError: null });
      },
      setTargetsError: (scope, targetsError) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ targetsStatus: "error", targetsError });
      },
      markListLoading: (scope) => {
        const active = get().authoritative?.scope;
        if (!active || !samePreviewScope(active, scope)) return;
        set({ listLoaded: false });
      },
      clear: () => set({ ...emptyState }),
    }),
    { name: "device-preview-store" },
  ),
);
