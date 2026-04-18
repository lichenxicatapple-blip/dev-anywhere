// 发送/打断主按钮：idle 显示 Send，working 切换为 Stop
// JSON 模式 Stop 发 session_worker_abort 控制消息；PTY 模式 Stop 发 Ctrl+C 原始字节
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";

interface SendButtonProps {
  sessionId: string;
  mode: "json" | "pty";
  isWorking: boolean;
  canSend: boolean;
  onSend: () => void;
}

export function SendButton({
  sessionId,
  mode,
  isWorking,
  canSend,
  onSend,
}: SendButtonProps) {
  function handleStop() {
    if (mode === "pty") {
      sendRemoteInputRaw(sessionId, "\x03");
      return;
    }
    relayClientRef?.sendControl({ type: "session_worker_abort", sessionId });
  }

  if (isWorking) {
    return (
      <Button
        type="button"
        size="icon"
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
