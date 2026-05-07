// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard
// StatusLine / QuotePreviewBar / InputBar 由 chat.tsx 统一承载，此文件只负责消息区
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { ThinkingIndicator } from "./thinking-indicator";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { EmptyState } from "@/components/shell/empty-state";
import { wsManagerRef } from "@/hooks/use-relay-setup";

interface ChatJsonViewProps {
  sessionId: string;
}

export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
  const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? EMPTY_SLICE.messages);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  // thinking indicator 的 working 态 = session.state === "working"
  const isWorking = useSessionStore(
    (s) => s.sessions.find((x) => x.sessionId === sessionId)?.state === "working",
  );
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);
  // 键盘弹起/收起会改变滚动容器 clientHeight, 若用户本来就在底部则自动继续贴底; 离底阅读旧消息时不打断
  const kbOffset = useVisualViewportBottomOffset();
  const isAtBottomSnapshot = useRef(isAtBottom);
  useEffect(() => {
    isAtBottomSnapshot.current = isAtBottom;
  }, [isAtBottom]);
  useEffect(() => {
    if (!scrollEl || !isAtBottomSnapshot.current) return;
    // 等布局完成再 pin: paddingBottom change -> flex-1 收缩 -> scrollHeight 更新在同一帧末, 延后一拍
    const raf = requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [kbOffset, scrollEl]);

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

  // 首屏 messages 从 0 到非 0 时强制滚到底: virtualizer.scrollToIndex 在
  // estimate→measure 过渡期定位不稳 (target 可能被 clamp 到 0), 直接设
  // scrollTop = scrollHeight 最可靠; 多轮 raf 补偿 measure 后 scrollHeight 收缩
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    initialScrollDoneRef.current = false;
  }, [sessionId]);
  useLayoutEffect(() => {
    if (!scrollEl || messages.length === 0 || initialScrollDoneRef.current) return;
    initialScrollDoneRef.current = true;
    const pin = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    pin();
    const r1 = requestAnimationFrame(() => {
      pin();
      requestAnimationFrame(pin);
    });
    setNewMsgsWhileAway(false);
    return () => cancelAnimationFrame(r1);
  }, [scrollEl, messages.length]);

  // isAtBottom 用 ref 传到下方新消息 effect: 新消息到达时只看"当前是否在底",
  // isAtBottom 自身变化不应触发 amber (离底仅代表用户在看旧消息, 不是有新消息)
  const isAtBottomRef = useRef(isAtBottom);
  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) setNewMsgsWhileAway(false);
  }, [isAtBottom]);

  // 新消息/streaming delta 到达: 若当前在底则追随, 否则记 "有新消息" (amber)
  useEffect(() => {
    if (!initialScrollDoneRef.current || messages.length === 0) return;
    if (isAtBottomRef.current) {
      virtualizer.scrollToIndex(messages.length - 1, {
        align: "end",
        behavior: "auto",
      });
    } else {
      setNewMsgsWhileAway(true);
    }
    // lastMsg?.text 让 streaming delta 每次追加也能触发 scrollToIndex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, lastMsg?.text]);

  const pendingApproval = pendingApprovals.find((a) => a.status === "pending");

  // Thinking spinner 只在 "请求已发、还没 streaming" 的 gap 段显示:
  // streaming 中 message-bubble 末尾的光标已经是"正在生成"的信号, 叠加会冗余
  const lastIsAssistantPartial = lastMsg?.role === "assistant" && lastMsg?.isPartial === true;
  const showThinking = isWorking && !lastIsAssistantPartial;

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
        <div ref={setScrollEl} className="absolute inset-0 overflow-auto" data-slot="message-list">
          {scrollEl && (
            // min-h-full + flex-1 filler 让 totalSize<clientHeight 时内容贴底显示,
            // 溢出时 filler basis=0 shrink→0, virtualizer 从顶部开始正常滚动
            <div className="flex flex-col min-h-full">
              <div className="flex-1" aria-hidden />
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
                    <MessageBubble message={messages[vi.index]} />
                  </div>
                ))}
              </div>
              {showThinking && <ThinkingIndicator />}
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
          <ToolApprovalCard approval={pendingApproval} sessionId={sessionId} container="inline" />
        </div>
      )}
    </div>
  );
}
