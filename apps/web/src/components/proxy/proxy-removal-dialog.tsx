import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ProxyRemovalTarget {
  proxyId: string;
  name?: string;
}

interface ProxyRemovalDialogProps {
  open: boolean;
  target: ProxyRemovalTarget | null;
  removing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function proxyRemovalDescription(target: ProxyRemovalTarget | null): string {
  const displayName = target?.name ?? target?.proxyId ?? "这台开发机";
  return `“${displayName}”只会从当前 Relay 的开发机列表中移除。不会删除机器上的文件或会话，也不会阻止它再次连接；以后重新运行时，它会重新出现在列表中。`;
}

export function ProxyRemovalDialog({
  open,
  target,
  removing,
  onOpenChange,
  onConfirm,
}: ProxyRemovalDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!removing) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        data-slot="proxy-removal-dialog"
        showCloseButton={!removing}
        onEscapeKeyDown={(event) => {
          if (removing) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (removing) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>移除离线开发机？</DialogTitle>
          <DialogDescription>{proxyRemovalDescription(target)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={removing}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={removing || !target}
            aria-busy={removing || undefined}
            onClick={onConfirm}
            data-slot="proxy-removal-confirm"
          >
            {removing && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {removing ? "正在移除" : "移除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
