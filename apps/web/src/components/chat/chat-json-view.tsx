// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard + StatusLine
// InputBar + SemanticActionPanel + QuotePreviewBar 在 Plan 10-04b 接入
// 占位 slot data-slot="input-bar-slot" 保留给 10-04b 替换
import { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "@/stores/chat-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { StatusLine } from "./status-line";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { EmptyState } from "@/components/shell/empty-state";

interface ChatJsonViewProps {
  sessionId: string;
}

export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
  // Plan 10-06 将此选择器改为 s.bySessionId[sessionId]?.messages ?? []
  const messages = useChatStore((s) => s.messages);
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const isWorking = useChatStore((s) => s.isWorking);

  // 用 state 持有滚动容器 DOM, 让 useEffect 依赖跟随元素挂载/卸载
  // 避免 ref 对象稳定但 current 首帧为 null 时 effect 捕获 null 后永不重绑 scroll listener
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);

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
      <div className="flex flex-col h-full">
        <div className="flex-1">
          <EmptyState variant="no-messages" />
        </div>
        <StatusLine
          state={isWorking ? "working" : "idle"}
          message={isWorking ? "Claude 正在响应..." : undefined}
        />
        <div
          data-slot="input-bar-slot"
          className="border-t border-border p-2 text-xs text-muted-foreground"
        >
          InputBar 待 Plan 10-04b 接入
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 滚动区 wrapper: 提供 relative 定位上下文给 BackToBottom, 让按钮不跟滚动位移 */}
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
      <div
        data-slot="input-bar-slot"
        className="border-t border-border p-2 text-xs text-muted-foreground"
      >
        InputBar 待 Plan 10-04b 接入
      </div>
    </div>
  );
}
