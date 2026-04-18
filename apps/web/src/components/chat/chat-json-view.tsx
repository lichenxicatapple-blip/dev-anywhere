// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard
// StatusLine / QuotePreviewBar / InputBar 由 chat.tsx 统一承载，此文件只负责消息区
import { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { EmptyState } from "@/components/shell/empty-state";
import { wsManagerRef } from "@/hooks/use-relay-setup";

interface ChatJsonViewProps {
  sessionId: string;
}

export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
  const messages = useChatStore(
    (s) => s.bySessionId[sessionId]?.messages ?? EMPTY_SLICE.messages,
  );
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);

  // 订阅 session + 拉取历史消息: 必须等 WS 连接 + proxy 已绑定 (relay NOT_BOUND 会丢请求)
  // 直接 URL 进入 /chat/:id 时, 本 effect 会在 connected/proxyOnline 变 true 后重放
  useEffect(() => {
    const ws = wsManagerRef;
    if (!ws || !sessionId || !connected || !proxyOnline) return;
    ws.send(JSON.stringify({ type: "session_subscribe", sessionId }));
    ws.send(JSON.stringify({ type: "session_messages_request", sessionId }));
  }, [sessionId, connected, proxyOnline]);

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

  if (messages.length === 0 && !pendingApproval) {
    return (
      <div className="h-full">
        <EmptyState variant="no-messages" />
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
    </div>
  );
}
