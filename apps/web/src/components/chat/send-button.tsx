// 发送/打断主按钮：idle 显示 Send，working 切换为 Stop
// JSON 模式 Stop 发 session_worker_abort 控制消息；PTY 的 Ctrl+C 归终端/header 控制入口。
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relayClientRef } from "@/hooks/use-relay-setup";

interface SendButtonProps {
  sessionId: string;
  isWorking: boolean;
  canSend: boolean;
  onSend: () => void;
}

export function SendButton({ sessionId, isWorking, canSend, onSend }: SendButtonProps) {
  function handleStop() {
    relayClientRef?.sendControl({ type: "session_worker_abort", sessionId });
  }

  if (isWorking) {
    return (
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="size-11 md:size-9"
        onClick={handleStop}
        aria-label="停止响应"
        data-slot="send-button"
        data-variant="stop"
      >
        <Square aria-hidden="true" />
      </Button>
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
