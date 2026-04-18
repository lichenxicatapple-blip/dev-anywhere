// 语义功能面板 (CONTEXT Addendum D-21): 5 个按钮跨 JSON/PTY 统一呈现
// PTY 模式通过 sendSemanticAction 发 remote_input_raw; JSON 模式直接调用 per-session chat-store action
import { Square, Settings2, ArrowUp, ArrowDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { sendSemanticAction } from "@/lib/ansi-keys";

interface SemanticActionPanelProps {
  sessionId: string;
  mode: "json" | "pty";
}

export function SemanticActionPanel({ sessionId, mode }: SemanticActionPanelProps) {
  function interrupt() {
    if (mode === "pty") {
      sendSemanticAction(sessionId, "interrupt");
      return;
    }
    // JSON 模式 interrupt 对应的 relay-control 类型未在 shared schema 中定义
    // 后续 schema 新增时再接入, 此处暂记日志而非静默
    console.warn("[semantic-action] JSON interrupt not wired: shared schema lacks worker_abort/interrupt type");
  }

  function togglePermissionMode() {
    if (mode === "pty") {
      sendSemanticAction(sessionId, "toggle_permission");
      return;
    }
    const current = useAppStore.getState().permissionMode;
    const next =
      current === "default"
        ? "auto_accept"
        : current === "auto_accept"
          ? "plan"
          : "default";
    useAppStore.getState().setPermissionMode(next);
    relayClientRef?.sendControl({ type: "permission_mode_change", mode: next });
  }

  function historyPrev() {
    if (mode === "pty") {
      sendSemanticAction(sessionId, "history_prev");
      return;
    }
    // JSON 模式: delta +1 向更早的历史; InputBar 的 effect 监听 cursor 同步 draft
    useChatStore.getState().moveInputHistoryCursor(sessionId, +1);
  }

  function historyNext() {
    if (mode === "pty") {
      sendSemanticAction(sessionId, "history_next");
      return;
    }
    useChatStore.getState().moveInputHistoryCursor(sessionId, -1);
  }

  function cancel() {
    if (mode === "pty") {
      sendSemanticAction(sessionId, "cancel");
      return;
    }
    const store = useChatStore.getState();
    store.setQuotedMessage(sessionId, null);
    store.setInputDraft(sessionId, "");
    store.resetInputHistoryCursor(sessionId);
  }

  return (
    <div
      className="flex flex-col gap-1 shrink-0"
      data-slot="semantic-action-panel"
      role="toolbar"
      aria-label="会话控制"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={interrupt}
        title="打断输出"
        aria-label="打断输出"
      >
        <Square aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={togglePermissionMode}
        title="切换审批模式"
        aria-label="切换审批模式"
      >
        <Settings2 aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={historyPrev}
        title="历史上一条"
        aria-label="历史上一条"
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={historyNext}
        title="历史下一条"
        aria-label="历史下一条"
      >
        <ArrowDown aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={cancel}
        title="取消"
        aria-label="取消"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
