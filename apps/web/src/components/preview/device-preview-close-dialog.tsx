import type { DevicePreviewSummary } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DevicePreviewCloseDialog({
  preview,
  closing,
  onOpenChange,
  onConfirm,
}: {
  preview: DevicePreviewSummary | null;
  closing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (preview: DevicePreviewSummary) => void;
}) {
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent data-slot="device-preview-close-dialog">
        <DialogHeader>
          <DialogTitle>停止预览？</DialogTitle>
          <DialogDescription>模拟器会继续在开发机上运行。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={closing}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!preview || closing}
            onClick={() => preview && onConfirm(preview)}
            data-slot="device-preview-close-confirm"
          >
            {closing ? "正在停止..." : "停止预览"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
