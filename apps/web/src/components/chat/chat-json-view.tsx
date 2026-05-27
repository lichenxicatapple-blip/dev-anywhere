// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard
// StatusLine / QuotePreviewBar / InputBar 由 chat.tsx 统一承载，此文件只负责消息区
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { ThinkingIndicator } from "./thinking-indicator";
import { StopButton } from "./send-button";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { EmptyState } from "@/components/shell/empty-state";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { getEffectiveChatContentFontSize } from "@/lib/chat-font-size";
import { estimateChatMessageHeight } from "@/lib/chat-message-size-estimate";
import { getTurnControlTarget } from "./turn-control-target";
import {
  appendJsonScrollTrace,
  formatJsonScrollTraceReport,
  isJsonScrollTraceEnabled,
} from "@/lib/json-scroll-trace";

interface ChatJsonViewProps {
  sessionId: string;
}

const HISTORY_PAGE_SIZE = 50;
const HISTORY_LOAD_TOP_THRESHOLD = 96;

export function ChatJsonView({ sessionId }: ChatJsonViewProps) {
  const messages = useChatStore((s) => s.bySessionId[sessionId]?.messages ?? EMPTY_SLICE.messages);
  const historyHasMore = useChatStore(
    (s) => s.bySessionId[sessionId]?.historyHasMore ?? EMPTY_SLICE.historyHasMore,
  );
  const historyNextBefore = useChatStore(
    (s) => s.bySessionId[sessionId]?.historyNextBefore ?? EMPTY_SLICE.historyNextBefore,
  );
  const historyLoading = useChatStore(
    (s) => s.bySessionId[sessionId]?.historyLoading ?? EMPTY_SLICE.historyLoading,
  );
  const setHistoryLoading = useChatStore((s) => s.setHistoryLoading);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  // thinking indicator 的 working 态 = session.state === "working"
  const isWorking = useSessionStore(
    (s) => s.sessions.find((x) => x.sessionId === sessionId)?.state === "working",
  );
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const chatContentFontSize = useAppStore((s) => s.chatContentFontSize);
  const desktopInteractionMode = useAppStore((s) => s.desktopInteractionMode);
  const nativeTouchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const touchEditingSurface = nativeTouchEditingSurface && !desktopInteractionMode;
  const effectiveChatContentFontSize = getEffectiveChatContentFontSize(
    chatContentFontSize,
    touchEditingSurface,
  );

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);
  const [traceEnabled, setTraceEnabled] = useState(() => isJsonScrollTraceEnabled());
  const [stopPending, setStopPending] = useState(false);
  const preservePrependRef = useRef<{ previousScrollHeight: number } | null>(null);
  const lastTraceGeometryRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const traceJsonScrollRef = useRef<
    (event: string, extra?: Partial<Parameters<typeof appendJsonScrollTrace>[0]>) => void
  >(() => {});
  const historyStateRef = useRef({
    hasMore: historyHasMore,
    nextBefore: historyNextBefore,
    loading: historyLoading,
  });
  useEffect(() => {
    historyStateRef.current = {
      hasMore: historyHasMore,
      nextBefore: historyNextBefore,
      loading: historyLoading,
    };
  }, [historyHasMore, historyNextBefore, historyLoading]);
  useEffect(() => {
    const updateTraceEnabled = (): void => {
      setTraceEnabled(isJsonScrollTraceEnabled());
    };
    updateTraceEnabled();
    window.addEventListener("hashchange", updateTraceEnabled);
    window.addEventListener("popstate", updateTraceEnabled);
    return () => {
      window.removeEventListener("hashchange", updateTraceEnabled);
      window.removeEventListener("popstate", updateTraceEnabled);
    };
  }, []);
  // 键盘弹起/收起会改变滚动容器 clientHeight, 若用户本来就在底部则自动继续贴底; 离底阅读旧消息时不打断
  const rawKbOffset = useVisualViewportBottomOffset();
  const kbOffset = desktopInteractionMode ? 0 : rawKbOffset;
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
    const relay = relayClientRef;
    if (!relay || !sessionId || !connected || !proxyOnline) return;
    relay.sendControl({ type: "session_subscribe", sessionId });
    const historySlice = useChatStore.getState().bySessionId[sessionId];
    if (historySlice?.historyLoading || historySlice?.historyInitialized) return;
    traceJsonScrollRef.current("history-initial:request");
    setHistoryLoading(sessionId, true);
    void relay
      .requestSessionMessagesPage(sessionId, { limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        traceJsonScrollRef.current("history-initial:response", {
          historyHasMore: page.hasMore,
        });
        useChatStore.getState().loadHistoryPage(sessionId, {
          mode: "replace",
          messages: page.messages,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
        });
      })
      .catch(() => useChatStore.getState().setHistoryLoading(sessionId, false));
  }, [sessionId, connected, proxyOnline, setHistoryLoading]);

  const loadOlderHistory = useCallback(() => {
    const relay = relayClientRef;
    const history = historyStateRef.current;
    if (!relay || !sessionId || !connected || !proxyOnline) return;
    if (!history.hasMore || !history.nextBefore || history.loading) return;
    historyStateRef.current = { ...history, loading: true };
    preservePrependRef.current = { previousScrollHeight: scrollEl?.scrollHeight ?? 0 };
    traceJsonScrollRef.current("history-prepend:request");
    setHistoryLoading(sessionId, true);
    void relay
      .requestSessionMessagesPage(sessionId, {
        limit: HISTORY_PAGE_SIZE,
        before: history.nextBefore,
      })
      .then((page) => {
        traceJsonScrollRef.current("history-prepend:response", {
          historyHasMore: page.hasMore,
        });
        useChatStore.getState().loadHistoryPage(sessionId, {
          mode: "prepend",
          messages: page.messages,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
        });
      })
      .catch(() => {
        traceJsonScrollRef.current("history-prepend:error");
        preservePrependRef.current = null;
        historyStateRef.current = { ...historyStateRef.current, loading: false };
        useChatStore.getState().setHistoryLoading(sessionId, false);
      });
  }, [connected, proxyOnline, scrollEl, sessionId, setHistoryLoading]);

  const handleMessageListScroll = useCallback(() => {
    if (!scrollEl) return;
    traceJsonScrollRef.current("scroll");
    if (scrollEl.scrollTop <= HISTORY_LOAD_TOP_THRESHOLD) {
      traceJsonScrollRef.current("scroll:top-threshold");
      loadOlderHistory();
    }
  }, [loadOlderHistory, scrollEl]);

  const getMessageItemKey = useCallback(
    (index: number) => messages[index]?.id ?? index,
    [messages],
  );
  const estimateMessageSize = useCallback(
    (index: number) =>
      estimateChatMessageHeight(messages[index], {
        fontSize: effectiveChatContentFontSize,
        touchEditingSurface,
      }),
    [effectiveChatContentFontSize, messages, touchEditingSurface],
  );

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollEl,
    estimateSize: estimateMessageSize,
    overscan: touchEditingSurface ? 8 : 5,
    getItemKey: getMessageItemKey,
  });

  const traceJsonScroll = useCallback(
    (event: string, extra: Partial<Parameters<typeof appendJsonScrollTrace>[0]> = {}) => {
      if (!isJsonScrollTraceEnabled()) return;
      const node = scrollEl;
      const items = virtualizer.getVirtualItems();
      const first = items[0];
      const last = items[items.length - 1];
      const previous = lastTraceGeometryRef.current;
      const scrollTop = node?.scrollTop ?? 0;
      const scrollHeight = node?.scrollHeight ?? 0;
      const visualViewport = window.visualViewport;
      appendJsonScrollTrace({
        t: performance.now(),
        event,
        scrollTop,
        scrollHeight,
        clientHeight: node?.clientHeight ?? 0,
        innerHeight: window.innerHeight,
        visualViewportHeight: visualViewport?.height,
        visualViewportOffsetTop: visualViewport?.offsetTop,
        messageCount: messages.length,
        totalSize: virtualizer.getTotalSize(),
        firstIndex: first?.index,
        lastIndex: last?.index,
        firstStart: first?.start,
        lastEnd: last?.end,
        focus:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.tagName ??
          null,
        atBottom: isAtBottomSnapshot.current,
        historyLoading: historyStateRef.current.loading,
        historyHasMore: historyStateRef.current.hasMore,
        preservePrepend: Boolean(preservePrependRef.current),
        scrollDelta: previous ? scrollTop - previous.scrollTop : undefined,
        scrollHeightDelta: previous ? scrollHeight - previous.scrollHeight : undefined,
        ...extra,
      });
      lastTraceGeometryRef.current = { scrollTop, scrollHeight };
    },
    [messages.length, scrollEl, virtualizer],
  );

  useEffect(() => {
    traceJsonScrollRef.current = traceJsonScroll;
  }, [traceJsonScroll]);

  const lastMsg = messages[messages.length - 1];
  const messageCountRef = useRef(messages.length);
  useEffect(() => {
    messageCountRef.current = messages.length;
  }, [messages.length]);

  useLayoutEffect(() => {
    virtualizer.measure();
    traceJsonScrollRef.current("virtualizer:measure");
    const messageCount = messageCountRef.current;
    if (!scrollEl || !isAtBottomSnapshot.current || messageCount === 0) return;
    let secondRaf = 0;
    const firstRaf = requestAnimationFrame(() => {
      secondRaf = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(messageCount - 1, { align: "end", behavior: "auto" });
      });
    });
    return () => {
      cancelAnimationFrame(firstRaf);
      cancelAnimationFrame(secondRaf);
    };
  }, [effectiveChatContentFontSize, scrollEl, virtualizer]);

  useLayoutEffect(() => {
    const preserve = preservePrependRef.current;
    if (!scrollEl || !preserve) return;
    traceJsonScrollRef.current("prepend-preserve:start");
    let secondRaf = 0;
    const firstRaf = requestAnimationFrame(() => {
      virtualizer.measure();
      secondRaf = requestAnimationFrame(() => {
        const delta = scrollEl.scrollHeight - preserve.previousScrollHeight;
        traceJsonScrollRef.current("prepend-preserve:apply", {
          scrollHeightDelta: delta,
        });
        if (delta > 0) scrollEl.scrollTop += delta;
        traceJsonScrollRef.current("prepend-preserve:after-scroll", {
          scrollHeightDelta: delta,
        });
        preservePrependRef.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(firstRaf);
      cancelAnimationFrame(secondRaf);
    };
  }, [messages.length, scrollEl, virtualizer]);

  // 首屏 messages 从 0 到非 0 时强制滚到底: virtualizer.scrollToIndex 在
  // estimate→measure 过渡期定位不稳 (target 可能被 clamp 到 0), 直接设
  // scrollTop = scrollHeight 最可靠; 多轮 raf 补偿 measure 后 scrollHeight 收缩
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    initialScrollDoneRef.current = false;
    setStopPending(false);
  }, [sessionId]);
  useLayoutEffect(() => {
    if (!scrollEl || messages.length === 0 || initialScrollDoneRef.current) return;
    initialScrollDoneRef.current = true;
    const pin = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      traceJsonScrollRef.current("initial-pin");
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
    if (preservePrependRef.current) return;
    if (isAtBottomRef.current) {
      traceJsonScrollRef.current("follow-output");
      virtualizer.scrollToIndex(messages.length - 1, {
        align: "end",
        behavior: "auto",
      });
    } else {
      traceJsonScrollRef.current("new-message-while-away");
      setNewMsgsWhileAway(true);
    }
    // lastMsg?.text 让 streaming delta 每次追加也能触发 scrollToIndex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, lastMsg?.text]);

  const pendingApprovalQueue = pendingApprovals.filter((a) => a.status === "pending");
  const hasPendingApprovals = pendingApprovalQueue.length > 0;

  useEffect(() => {
    if (!isWorking) setStopPending(false);
  }, [isWorking]);

  const handleStopTurn = useCallback(() => {
    if (stopPending) return;
    setStopPending(true);
    const sent = relayClientRef?.sendControl({ type: "session_worker_abort", sessionId });
    if (sent === false || !relayClientRef) setStopPending(false);
  }, [sessionId, stopPending]);

  const turnControlTarget = getTurnControlTarget({
    messages,
    isWorking,
    hasPendingApprovals,
  });
  const turnStopControl =
    isWorking && !hasPendingApprovals ? (
      <StopButton isStopping={stopPending} onStop={handleStopTurn} />
    ) : null;
  const showThinking = turnControlTarget.showThinking;
  const hasHistoryMessages = messages.some((message) =>
    message.id.startsWith(`history-${sessionId}-`),
  );

  if (messages.length === 0 && !hasPendingApprovals) {
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
          className="dev-render-scroll absolute inset-0 overflow-auto"
          data-slot="message-list"
          onScroll={handleMessageListScroll}
        >
          {scrollEl && (
            // min-h-full + flex-1 filler 让 totalSize<clientHeight 时内容贴底显示,
            // 溢出时 filler basis=0 shrink→0, virtualizer 从顶部开始正常滚动
            <div className="flex flex-col min-h-full">
              <div className="flex-1" aria-hidden />
              {(historyLoading || historyHasMore || hasHistoryMessages) && (
                <div
                  className="mx-auto flex min-h-10 w-full max-w-[var(--dev-message-rail-width)] items-center justify-center px-4 py-2 text-xs text-muted-foreground"
                  data-slot="history-scrollback-status"
                >
                  {historyLoading
                    ? "正在加载更早消息..."
                    : historyHasMore
                      ? "继续上滑加载更早消息"
                      : "已到最早记录"}
                </div>
              )}
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const message = messages[vi.index];
                  return (
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
                        message={message}
                        contentFontSize={effectiveChatContentFontSize}
                        turnControl={
                          message?.id === turnControlTarget.messageId ? turnStopControl : undefined
                        }
                      />
                    </div>
                  );
                })}
              </div>
              {showThinking && <ThinkingIndicator turnControl={turnStopControl} />}
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
        {traceEnabled ? <JsonScrollTraceButton /> : null}
      </div>
      {hasPendingApprovals && (
        <div
          className="dev-render-scroll dev-chat-rail-inset flex flex-col gap-2 overflow-x-hidden overflow-y-auto py-2"
          aria-live="polite"
        >
          {pendingApprovalQueue.length > 1 && (
            <div className="dev-message-rail mx-auto w-full min-w-0 px-1 text-xs text-muted-foreground">
              {pendingApprovalQueue.length} 个工具审批待处理
            </div>
          )}
          {pendingApprovalQueue.map((approval, index) => (
            <ToolApprovalCard
              key={approval.requestId}
              approval={approval}
              sessionId={sessionId}
              container="inline"
              queuePosition={index + 1}
              queueSize={pendingApprovalQueue.length}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JsonScrollTraceButton() {
  const [copied, setCopied] = useState(false);

  async function handleClick(): Promise<void> {
    const text = formatJsonScrollTraceReport();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      window.prompt("Copy JSON scroll trace", text);
    }
  }

  return (
    <button
      type="button"
      className="absolute left-3 bottom-3 z-30 rounded border border-[#4A4A4A] bg-[#1E1E1E]/90 px-2 py-1 text-[11px] text-[#C8C8C8]"
      onClick={handleClick}
      data-slot="json-scroll-trace-copy"
    >
      {copied ? "Copied" : "Trace"}
    </button>
  );
}
