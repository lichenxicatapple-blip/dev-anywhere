import type { SessionInfo } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SessionTerminationDialogProps {
  open: boolean;
  session: SessionInfo | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (session: SessionInfo) => void;
}

function isLocalTerminalPty(session: SessionInfo | null): boolean {
  return session?.mode === "pty" && session.ptyOwner === "local-terminal";
}

function isPureTerminalSession(session: SessionInfo | null): boolean {
  return session?.kind === "terminal";
}

export function sessionTerminationCopy(session: SessionInfo | null): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
} {
  if (isLocalTerminalPty(session)) {
    return {
      title: "断开远程连接？",
      description:
        "这只会断开当前页面和本地终端的连接，本地终端里的 Claude Code/Codex 会继续运行。重新接入前，页面不能继续查看或输入这个会话。",
      confirmLabel: "断开远程连接",
      destructive: false,
    };
  }

  if (isPureTerminalSession(session)) {
    return {
      title: "终止终端？",
      description:
        "这会停止当前终端进程，并清理这个终端会话的运行状态。终止后不能继续输入，也无法恢复正在执行的命令。",
      confirmLabel: "终止终端",
      destructive: true,
    };
  }

  return {
    title: "终止会话？",
    description:
      "这会停止当前 Agent 进程，并清理这个会话的运行状态。终止后不能继续输入，也无法恢复正在执行的任务。",
    confirmLabel: "终止会话",
    destructive: true,
  };
}

export function SessionTerminationDialog({
  open,
  session,
  onOpenChange,
  onConfirm,
}: SessionTerminationDialogProps) {
  const copy = sessionTerminationCopy(session);

  function handleConfirm() {
    if (!session) return;
    onConfirm(session);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="session-termination-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            variant={copy.destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            data-slot="session-termination-confirm"
          >
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
