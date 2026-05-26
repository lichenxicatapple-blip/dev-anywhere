// 发送按钮：busy 时仍使用同一个发送入口，内部按输入栏状态排队。
// Stop 是当前 turn 的控制动作，由消息区按 active surface 动态挂载。
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SendButtonProps {
  isWorking: boolean;
  canSend: boolean;
  canQueue?: boolean;
  onSend: () => void;
  onQueue?: () => void;
}

interface StopButtonProps {
  isStopping: boolean;
  onStop: () => void;
  className?: string;
}

export function SendButton({
  isWorking,
  canSend,
  canQueue = false,
  onSend,
  onQueue,
}: SendButtonProps) {
  const canSubmit = canSend || canQueue;

  return (
    <Button
      type="submit"
      size="icon"
      className="size-11 md:size-9"
      disabled={!canSubmit}
      onClick={(e) => {
        e.preventDefault();
        if (canSend) {
          onSend();
          return;
        }
        if (canQueue) onQueue?.();
      }}
      aria-label="发送"
      data-slot="send-button"
      data-variant="send"
      data-busy-queue={isWorking && canQueue ? "true" : undefined}
    >
      <Send aria-hidden="true" />
    </Button>
  );
}

export function StopButton({ isStopping, onStop, className }: StopButtonProps) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn(
        "relative overflow-visible rounded-md border border-transparent text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/25 disabled:opacity-100",
        isStopping ? "bg-destructive/10 text-destructive" : "",
        className,
      )}
      onClick={onStop}
      disabled={isStopping}
      aria-busy={isStopping ? "true" : undefined}
      aria-label="停止响应"
      data-slot="stop-button"
      data-variant="stop"
    >
      {isStopping ? (
        <span
          data-testid="stop-progress-ring"
          className="pointer-events-none absolute -inset-1 rounded-md border border-transparent border-t-destructive border-r-destructive/70 animate-spin"
          aria-hidden="true"
        />
      ) : null}
      <Square aria-hidden="true" />
    </Button>
  );
}
