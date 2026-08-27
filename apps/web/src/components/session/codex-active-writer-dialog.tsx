import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionStore } from "@/stores/session-store";

export function CodexActiveWriterDialog() {
  const conflict = useSessionStore((state) => state.codexActiveWriterConflict);
  const setConflict = useSessionStore((state) => state.setCodexActiveWriterConflict);
  const close = () => setConflict(null);

  return (
    <Dialog open={conflict !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent focusSurfaceOnOpen className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>该 Codex 会话仍在运行</DialogTitle>
          <DialogDescription className="space-y-2 text-left leading-6">
            <span className="block">
              另一个 Codex 进程正在使用此会话
              {conflict?.activeWriterPid ? (
                <>
                  （PID{" "}
                  <span className="font-mono text-foreground">{conflict.activeWriterPid}</span>）
                </>
              ) : null}
              。
            </span>
            <span className="block">
              它可能来自本机终端、Codex App 或另一条 DEV Anywhere
              会话。请先回到或结束原会话后再重试。
            </span>
            <span className="block text-muted-foreground/80">
              DEV Anywhere 不会自动终止该进程。
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={close} autoFocus>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
