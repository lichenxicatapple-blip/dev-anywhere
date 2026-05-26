// 发送/打断主按钮：idle 显示 Send，working 显示 Stop；有草稿时可加入待发送队列。
// JSON 模式 Stop 请求中断当前 turn；PTY 的 Ctrl+C 归终端/header 控制入口。
import { ListPlus, Send, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface SendButtonProps {
  sessionId: string;
  isWorking: boolean;
  canSend: boolean;
  canQueue?: boolean;
  onSend: () => void;
  onQueue?: () => void;
}

export function SendButton({
  sessionId,
  isWorking,
  canSend,
  canQueue = false,
  onSend,
  onQueue,
}: SendButtonProps) {
  const [isStopping, setIsStopping] = useState(false);

  useEffect(() => {
    if (!isWorking) setIsStopping(false);
  }, [isWorking, sessionId]);

  function handleStop() {
    setIsStopping(true);
    relayClientRef?.sendControl({ type: "session_worker_abort", sessionId });
  }

  if (isWorking) {
    return (
      <>
        {canQueue ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-11 md:size-9"
            onClick={(event) => {
              event.preventDefault();
              onQueue?.();
            }}
            aria-label="加入发送队列"
            data-slot="send-button"
            data-variant="queue"
          >
            <ListPlus aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant={isStopping ? "secondary" : "destructive"}
          className="relative size-11 overflow-visible md:size-9 disabled:opacity-100"
          onClick={handleStop}
          disabled={isStopping}
          aria-busy={isStopping ? "true" : undefined}
          aria-label="停止响应"
          data-slot="send-button"
          data-variant="stop"
        >
          {isStopping ? (
            <span
              data-testid="stop-progress-ring"
              className="pointer-events-none absolute -inset-1 rounded-lg border border-transparent border-t-destructive border-r-destructive/70 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          <Square aria-hidden="true" />
        </Button>
      </>
    );
  }

  return (
    <Button
      type="submit"
      size="icon"
      className="size-11 md:size-9"
      disabled={!canSend}
      onClick={(e) => {
        e.preventDefault();
        onSend();
      }}
      aria-label="发送"
      data-slot="send-button"
      data-variant="send"
    >
      <Send aria-hidden="true" />
    </Button>
  );
}
