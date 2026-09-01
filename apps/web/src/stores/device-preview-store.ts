import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  DevicePreviewCapability,
  DevicePreviewSnapshot,
  DevicePreviewSummary,
  DevicePreviewTarget,
} from "@/types/device-preview";

type LoadStatus = "idle" | "loading" | "loaded" | "error";

interface DevicePreviewStoreState {
  previews: DevicePreviewSummary[];
  targets: DevicePreviewTarget[];
  capability: DevicePreviewCapability | null;
  capabilityStatus: LoadStatus;
  capabilityError: string | null;
  targetsStatus: LoadStatus;
  targetsError: string | null;
  listLoaded: boolean;
  epoch: string | null;
  revision: number;

  replaceSnapshot: (snapshot: DevicePreviewSnapshot) => void;
  addStartingPreview: (preview: DevicePreviewSummary) => void;
  applyPreviewState: (preview: DevicePreviewSummary, epoch?: string, revision?: number) => void;
  applyPreviewRemoved: (previewId: string, epoch?: string, revision?: number) => void;
  setPreviewState: (previewId: string, state: DevicePreviewSummary["state"]) => void;
  setPreviewStateIf: (
    previewId: string,
    expected: DevicePreviewSummary["state"],
    state: DevicePreviewSummary["state"],
  ) => void;
  setCapability: (capability: DevicePreviewCapability) => void;
  setCapabilityUnsupported: () => void;
  setTargetsLoading: () => void;
  setTargets: (targets: DevicePreviewTarget[]) => void;
  setTargetsError: (error: string) => void;
  markListLoading: () => void;
  prepareForProxySwitch: () => void;
  clear: () => void;
}

const emptyState = {
  previews: [] as DevicePreviewSummary[],
  targets: [] as DevicePreviewTarget[],
  capability: null as DevicePreviewCapability | null,
  capabilityStatus: "idle" as LoadStatus,
  capabilityError: null as string | null,
  targetsStatus: "idle" as LoadStatus,
  targetsError: null as string | null,
  listLoaded: false,
  epoch: null as string | null,
  revision: -1,
};

function shouldIgnoreRevision(
  state: Pick<DevicePreviewStoreState, "epoch" | "revision">,
  epoch?: string,
  revision?: number,
): boolean {
  return !!epoch && revision !== undefined && state.epoch === epoch && revision <= state.revision;
}

function upsert(
  previews: DevicePreviewSummary[],
  preview: DevicePreviewSummary,
): DevicePreviewSummary[] {
  const index = previews.findIndex((entry) => entry.previewId === preview.previewId);
  if (index < 0) return [...previews, preview];
  const next = previews.slice();
  next[index] = preview;
  return next;
}

export const useDevicePreviewStore = create<DevicePreviewStoreState>()(
  devtools(
    (set) => ({
      ...emptyState,
      replaceSnapshot: (snapshot) =>
        set((state) => {
          if (state.epoch === snapshot.epoch && snapshot.revision < state.revision) return state;
          return {
            previews: snapshot.previews,
            listLoaded: true,
            epoch: snapshot.epoch,
            revision: snapshot.revision,
          };
        }),
      addStartingPreview: (preview) =>
        set((state) =>
          state.previews.some((entry) => entry.previewId === preview.previewId)
            ? state
            : { previews: [...state.previews, preview] },
        ),
      applyPreviewState: (preview, epoch, revision) =>
        set((state) => {
          if (shouldIgnoreRevision(state, epoch, revision)) return state;
          const epochChanged = !!epoch && !!state.epoch && epoch !== state.epoch;
          return {
            previews: upsert(epochChanged ? [] : state.previews, preview),
            ...(epoch ? { epoch } : {}),
            ...(revision !== undefined ? { revision } : {}),
            ...(epochChanged ? { listLoaded: false } : {}),
          };
        }),
      applyPreviewRemoved: (previewId, epoch, revision) =>
        set((state) => {
          if (shouldIgnoreRevision(state, epoch, revision)) return state;
          const epochChanged = !!epoch && !!state.epoch && epoch !== state.epoch;
          return {
            previews: epochChanged
              ? []
              : state.previews.filter((preview) => preview.previewId !== previewId),
            ...(epoch ? { epoch } : {}),
            ...(revision !== undefined ? { revision } : {}),
            ...(epochChanged ? { listLoaded: false } : {}),
          };
        }),
      setPreviewState: (previewId, previewState) =>
        set((state) => ({
          previews: state.previews.map((preview) =>
            preview.previewId === previewId
              ? { ...preview, state: previewState, updatedAt: Date.now() }
              : preview,
          ),
        })),
      setPreviewStateIf: (previewId, expected, previewState) =>
        set((state) => ({
          previews: state.previews.map((preview) =>
            preview.previewId === previewId && preview.state === expected
              ? { ...preview, state: previewState, updatedAt: Date.now() }
              : preview,
          ),
        })),
      setCapability: (capability) =>
        set({ capability, capabilityStatus: "loaded", capabilityError: null }),
      setCapabilityUnsupported: () =>
        set({
          capability: null,
          capabilityStatus: "loaded",
          capabilityError: null,
          previews: [],
          targets: [],
          targetsStatus: "loaded",
          listLoaded: true,
          epoch: null,
          revision: -1,
        }),
      setTargetsLoading: () => set({ targetsStatus: "loading", targetsError: null }),
      setTargets: (targets) => set({ targets, targetsStatus: "loaded", targetsError: null }),
      setTargetsError: (targetsError) => set({ targetsStatus: "error", targetsError }),
      markListLoading: () => set({ listLoaded: false }),
      prepareForProxySwitch: () => set({ ...emptyState }),
      clear: () => set({ ...emptyState }),
    }),
    { name: "device-preview-store" },
  ),
);
