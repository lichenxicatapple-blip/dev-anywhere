import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  WebPreviewCapability,
  WebPreviewSnapshot,
  WebPreviewState,
  WebPreviewSummary,
} from "@/types/web-preview";

type PreviewCapabilityStatus = "idle" | "loading" | "loaded" | "error";

interface PreviewStoreState {
  previews: WebPreviewSummary[];
  listLoaded: boolean;
  epoch: string | null;
  revision: number;
  capability: WebPreviewCapability | null;
  capabilityStatus: PreviewCapabilityStatus;
  capabilityError: string | null;

  replaceSnapshot: (snapshot: WebPreviewSnapshot) => void;
  addStartingPreview: (preview: WebPreviewSummary) => void;
  applyPreviewState: (preview: WebPreviewSummary, epoch?: string, revision?: number) => void;
  applyPreviewRemoved: (previewId: string, epoch?: string, revision?: number) => void;
  setPreviewState: (previewId: string, state: WebPreviewState) => void;
  setCapabilityLoading: () => void;
  setCapability: (capability: WebPreviewCapability) => void;
  setCapabilityUnsupported: () => void;
  setCapabilityError: (error: string) => void;
  markListLoading: () => void;
  clearPreviewList: () => void;
  prepareForProxySwitch: () => void;
  clear: () => void;
}

function upsertPreview(
  previews: WebPreviewSummary[],
  preview: WebPreviewSummary,
): WebPreviewSummary[] {
  const index = previews.findIndex((entry) => entry.previewId === preview.previewId);
  if (index < 0) return [...previews, preview];
  const next = previews.slice();
  next[index] = preview;
  return next;
}

function shouldIgnoreRevision(
  state: Pick<PreviewStoreState, "epoch" | "revision">,
  epoch: string | undefined,
  revision: number | undefined,
): boolean {
  if (!epoch || revision === undefined) return false;
  return state.epoch === epoch && revision <= state.revision;
}

const emptyPreviewState = {
  previews: [] as WebPreviewSummary[],
  listLoaded: false,
  epoch: null as string | null,
  revision: -1,
  capability: null as WebPreviewCapability | null,
  capabilityStatus: "idle" as PreviewCapabilityStatus,
  capabilityError: null as string | null,
};

export const usePreviewStore = create<PreviewStoreState>()(
  devtools(
    (set) => ({
      ...emptyPreviewState,

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
        set((state) => {
          // A very fast state push may beat the create ACK. Never overwrite ready/failed state
          // with the synthetic starting row produced from that ACK.
          if (state.previews.some((entry) => entry.previewId === preview.previewId)) return state;
          return { previews: [...state.previews, preview] };
        }),
      applyPreviewState: (preview, epoch, revision) =>
        set((state) => {
          if (shouldIgnoreRevision(state, epoch, revision)) return state;
          const epochChanged = !!epoch && !!state.epoch && epoch !== state.epoch;
          return {
            previews: upsertPreview(epochChanged ? [] : state.previews, preview),
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
      setCapabilityLoading: () => set({ capabilityStatus: "loading", capabilityError: null }),
      setCapability: (capability) =>
        set({ capability, capabilityStatus: "loaded", capabilityError: null }),
      setCapabilityUnsupported: () =>
        set({
          capability: null,
          capabilityStatus: "loaded",
          capabilityError: null,
          previews: [],
          listLoaded: true,
          epoch: null,
          revision: -1,
        }),
      setCapabilityError: (capabilityError) => set({ capabilityStatus: "error", capabilityError }),
      markListLoading: () => set({ listLoaded: false }),
      clearPreviewList: () => set({ previews: [], listLoaded: true, epoch: null, revision: -1 }),
      prepareForProxySwitch: () => set({ ...emptyPreviewState }),
      clear: () => set({ ...emptyPreviewState }),
    }),
    { name: "preview-store" },
  ),
);
