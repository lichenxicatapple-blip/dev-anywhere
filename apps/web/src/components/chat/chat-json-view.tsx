// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard + StatusLine
// InputBar + SemanticActionPanel + QuotePreviewBar 随视图一起渲染, 不由 chat.tsx 拼装
import { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "@/stores/chat-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { StatusLine } from "./status-line";
import { InputBar } from "./input-bar";
import { SemanticActionPanel } from "./semantic-action-panel";
import { QuotePreviewBar } from "./quote-preview-bar";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { EmptyState } from "@/components/shell/empty-state";
import { wsManagerRef } from "@/hooks/use-relay-setup";

interface ChatJsonViewProps {
  sessionId: string;
}

export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
  // Plan 10-06 将此选择器改为 s.bySessionId[sessionId]?.messages ?? []
  const messages = useChatStore((s) => s.messages);
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const isWorking = useChatStore((s) => s.isWorking);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);

  // mount 时订阅 session 并拉取已持久化的历史消息
  useEffect(() => {
    const ws = wsManagerRef;
    if (!ws || !sessionId) return;
    ws.send(JSON.stringify({ type: "session_subscribe", sessionId }));
    ws.send(JSON.stringify({ type: "session_messages_request", sessionId }));
  }, [sessionId]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 120,
    overscan: 5,
  });

  const lastMsg = messages[messages.length - 1];

  // 自动追随: streaming delta -> auto (无动画); 离底时只记 "有新消息"
  useEffect(() => {
    if (messages.length === 0) return;
    if (isAtBottom) {
      virtualizer.scrollToIndex(messages.length - 1, {
        align: "end",
        behavior: "auto",
      });
      setNewMsgsWhileAway(false);
    } else {
      setNewMsgsWhileAway(true);
    }
    // lastMsg?.text 让 streaming delta 每次追加也能触发 scrollToIndex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, lastMsg?.text, isAtBottom]);

  const pendingApproval = pendingApprovals.find((a) => a.status === "pending");

  function renderInputRegion() {
    return (
      <>
        <QuotePreviewBar sessionId={sessionId} />
        <div
          className="flex items-end gap-2 p-2 border-t border-border"
          data-slot="input-bar-region"
        >
          <InputBar sessionId={sessionId} mode="json" />
          <SemanticActionPanel sessionId={sessionId} mode="json" />
        </div>
      </>
    );
  }

  if (messages.length === 0 && !pendingApproval) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1">
          <EmptyState variant="no-messages" />
        </div>
        <StatusLine
          state={isWorking ? "working" : "idle"}
          message={isWorking ? "Claude 正在响应..." : undefined}
        />
        {renderInputRegion()}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 relative min-h-0">
        <div
          ref={setScrollEl}
          className="absolute inset-0 overflow-auto"
          data-slot="message-list"
        >
          {scrollEl && (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <MessageBubble
                    message={messages[vi.index]}
                    sessionId={sessionId}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <BackToBottom
          visible={!isAtBottom}
          hasNewMessages={newMsgsWhileAway}
          onClick={() => {
            // 用户点击 -> smooth
            virtualizer.scrollToIndex(Math.max(messages.length - 1, 0), {
              align: "end",
              behavior: "smooth",
            });
            scrollToBottom();
            setNewMsgsWhileAway(false);
          }}
        />
      </div>
      {pendingApproval && (
        <div className="px-4 py-2" aria-live="polite">
          <ToolApprovalCard
            approval={pendingApproval}
            sessionId={sessionId}
            container="inline"
          />
        </div>
      )}
      <StatusLine
        state={isWorking ? "working" : "idle"}
        message={isWorking ? "Claude 正在响应..." : undefined}
      />
      {renderInputRegion()}
    </div>
  );
}
