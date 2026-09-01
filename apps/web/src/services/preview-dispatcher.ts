import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { usePreviewStore } from "@/stores/preview-store";
import { registerDispatcher } from "./dispatcher-registry";
import type { InboundMessage } from "./relay-client";

async function copyPreviewUrl(url: string): Promise<void> {
  const result = await copyText(url, { allowLegacyFallback: true });
  if (result === "failed") {
    toast.error("复制失败，请稍后重试");
    return;
  }
  toast.success("链接已复制");
}

export function dispatchPreviewMessage(msg: InboundMessage): void {
  const store = usePreviewStore.getState();
  switch (msg.type) {
    case "preview_state_push": {
      const previous = store.previews.find(
        (preview) => preview.previewId === msg.preview.previewId,
      );
      store.applyPreviewState(msg.preview, msg.epoch, msg.revision);
      const applied = usePreviewStore
        .getState()
        .previews.find((preview) => preview.previewId === msg.preview.previewId);
      if (
        msg.preview.state === "ready" &&
        previous?.state !== "ready" &&
        applied?.state === "ready" &&
        applied.updatedAt === msg.preview.updatedAt
      ) {
        if (msg.preview.publicUrl) {
          toast.success("预览已就绪", {
            action: {
              label: "复制链接",
              onClick: () => void copyPreviewUrl(msg.preview.publicUrl!),
            },
          });
        } else {
          toast.success("预览已就绪");
        }
      }
      break;
    }
    case "preview_removed_push":
      store.applyPreviewRemoved(msg.previewId, msg.epoch, msg.revision);
      break;
    default:
      break;
  }
}

export function registerPreviewDispatcher(): () => void {
  return registerDispatcher("registerPreviewDispatcher", () => dispatchPreviewMessage);
}
