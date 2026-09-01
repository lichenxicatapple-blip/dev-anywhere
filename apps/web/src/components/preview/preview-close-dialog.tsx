import type { PreviewSummary } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PreviewCloseDialogProps {
  preview: PreviewSummary | null;
  closing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (preview: PreviewSummary) => void;
}

export function PreviewCloseDialog({
  preview,
  closing,
  onOpenChange,
  onConfirm,
}: PreviewCloseDialogProps) {
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent data-slot="preview-close-dialog">
        <DialogHeader>
          <DialogTitle>关闭预览？</DialogTitle>
          <DialogDescription>关闭后，当前预览链接将立即失效。</DialogDescription>
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
            data-slot="preview-close-confirm"
          >
            {closing ? "正在关闭..." : "关闭预览"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
