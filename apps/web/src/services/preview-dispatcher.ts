import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { previewController } from "@/services/preview-controller";
import { selectWebPreviews, usePreviewStore } from "@/stores/preview-store";
import { registerDispatcher } from "./dispatcher-registry";
import type { InboundMessage, RelayClient } from "./relay-client";

async function copyPreviewUrl(url: string): Promise<void> {
  const result = await copyText(url, { allowUserGestureFallback: true });
  if (result === "failed") {
    toast.error("复制失败，请稍后重试");
    return;
  }
  toast.success("链接已复制");
}

export function dispatchPreviewMessage(relay: RelayClient, msg: InboundMessage): void {
  const previous =
    msg.type === "preview_state_push" && previewController.isActive(relay, msg.scope)
      ? selectWebPreviews(usePreviewStore.getState()).find(
          (preview) => preview.previewId === msg.preview.previewId,
        )
      : undefined;
  if (!previewController.handleMessage(relay, msg) || msg.type !== "preview_state_push") {
    return;
  }

  const applied = selectWebPreviews(usePreviewStore.getState()).find(
    (preview) => preview.previewId === msg.preview.previewId,
  );
  if (
    msg.preview.state !== "ready" ||
    previous?.state === "ready" ||
    applied?.state !== "ready" ||
    applied.updatedAt !== msg.preview.updatedAt
  ) {
    return;
  }
  const publicUrl = msg.preview.publicUrl;

  toast.success("预览已就绪", {
    action: {
      label: "复制链接",
      onClick: () => void copyPreviewUrl(publicUrl),
    },
  });
}

export function registerPreviewDispatcher(): () => void {
  return registerDispatcher(
    "registerPreviewDispatcher",
    (relay) => (msg) => dispatchPreviewMessage(relay, msg),
  );
}
