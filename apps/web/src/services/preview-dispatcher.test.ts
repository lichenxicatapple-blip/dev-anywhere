import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewStore } from "@/stores/preview-store";

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

describe("preview-dispatcher", () => {
  beforeEach(() => {
    usePreviewStore.getState().clear();
    toastSuccess.mockReset();
    toastError.mockReset();
    copyText.mockReset();
    copyText.mockResolvedValue("clipboard");
  });

  it("upserts state pushes and exposes a working copy action", async () => {
    dispatchPreviewMessage({
      type: "preview_state_push",
      epoch: "epoch-a",
      revision: 1,
      preview: readyPreview,
    });

    expect(usePreviewStore.getState().previews).toEqual([readyPreview]);
    expect(toastSuccess).toHaveBeenCalledOnce();

    const options = toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } };
    expect(options.action.onClick).toEqual(expect.any(Function));
    options.action.onClick();
    await vi.waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(readyPreview.publicUrl, {
        allowLegacyFallback: true,
      }),
    );
  });

  it("removes previews from a removed push", () => {
    usePreviewStore.getState().applyPreviewState(readyPreview, "epoch-a", 1);

    dispatchPreviewMessage({
      type: "preview_removed_push",
      epoch: "epoch-a",
      revision: 2,
      previewId: readyPreview.previewId,
    });

    expect(usePreviewStore.getState().previews).toEqual([]);
  });
});
