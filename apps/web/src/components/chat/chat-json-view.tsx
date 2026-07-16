// JSON 模式主视图: 虚拟滚动消息列表 + 内联 ToolApprovalCard
// StatusLine / QuotePreviewBar / InputBar 由 chat.tsx 统一承载，此文件只负责消息区
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { MessageBubble } from "./message-bubble";
import { ToolApprovalCard } from "./tool-approval-card";
import { BackToBottom } from "./back-to-bottom";
import { ThinkingIndicator } from "./thinking-indicator";
import { StopButton } from "./send-button";
import { ChatFindBar } from "./chat-find-bar";
import { useChatFindShortcuts } from "./use-chat-find-shortcuts";
import { useFollowOutput } from "@/hooks/use-follow-output";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { EmptyState } from "@/components/shell/empty-state";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { getEffectiveChatContentFontSize } from "@/lib/chat-font-size";
import { estimateChatMessageHeight } from "@/lib/chat-message-size-estimate";
import { getTurnControlTarget } from "./turn-control-target";
import { isLiveVoiceTranscript } from "./chat-message-follow";
import { findChatMessageIndexes } from "@/lib/chat-message-search";
import { toast } from "@/components/toast";
import {
  appendJsonScrollTrace,
  formatJsonScrollTraceReport,
  isJsonScrollTraceEnabled,
} from "@/lib/json-scroll-trace";

interface ChatJsonViewProps {
  sessionId: string;
  findRequest?: number;
}

const HISTORY_PAGE_SIZE = 50;
const HISTORY_LOAD_TOP_THRESHOLD = 96;
type SearchHistoryMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
  cursor?: string;
};

export function ChatJsonView({ sessionId, findRequest }: ChatJsonViewProps) {
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
  const forceHardwareInput = useAppStore((s) => s.inputModePreference === "hardware");
  const nativeTouchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const touchEditingSurface = nativeTouchEditingSurface && !forceHardwareInput;
  const effectiveChatContentFontSize = getEffectiveChatContentFontSize(
    chatContentFontSize,
    touchEditingSurface,
  );

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isAtBottom, scrollToBottom } = useFollowOutput(scrollEl);
  const [newMsgsWhileAway, setNewMsgsWhileAway] = useState(false);
  const [traceEnabled, setTraceEnabled] = useState(() => isJsonScrollTraceEnabled());
  const [stopPending, setStopPending] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [activeFindMessageId, setActiveFindMessageId] = useState<string | null>(null);
  const [findHistoryLoading, setFindHistoryLoading] = useState(false);
  const [findHistoryFailed, setFindHistoryFailed] = useState(false);
  const findHistoryLoadGenerationRef = useRef(0);
  const findHistoryLoadingRef = useRef(false);
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
  const kbOffset = forceHardwareInput ? 0 : rawKbOffset;
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

  const loadAllHistoryForFind = useCallback(async (): Promise<void> => {
    const relay = relayClientRef;
    const currentSlice = useChatStore.getState().bySessionId[sessionId];
    if (!relay || !connected || !proxyOnline || !currentSlice?.historyHasMore) return;
    if (!currentSlice.historyNextBefore || findHistoryLoadingRef.current) return;

    const generation = ++findHistoryLoadGenerationRef.current;
    findHistoryLoadingRef.current = true;
    setFindHistoryLoading(true);
    setFindHistoryFailed(false);
    setHistoryLoading(sessionId, true);
    historyStateRef.current = {
      hasMore: currentSlice.historyHasMore,
      nextBefore: currentSlice.historyNextBefore,
      loading: true,
    };

    let before: string | undefined = currentSlice.historyNextBefore;
    let hasMore: boolean = currentSlice.historyHasMore;
    const seenCursors = new Set<string>();
    const collectedPages: SearchHistoryMessage[][] = [];

    try {
      while (hasMore && before) {
        if (seenCursors.has(before)) {
          throw new Error(`History pagination repeated cursor: ${before}`);
        }
        seenCursors.add(before);
        const page = await relay.requestSessionMessagesPage(sessionId, {
          limit: 200,
          before,
        });
        if (generation !== findHistoryLoadGenerationRef.current) return;
        collectedPages.push(page.messages);
        hasMore = page.hasMore;
        if (hasMore && !page.nextBefore) {
          throw new Error("History pagination omitted nextBefore while hasMore is true");
        }
        before = page.nextBefore;
      }

      if (generation !== findHistoryLoadGenerationRef.current) return;
      const collected = collectedPages.reverse().flat();
      historyStateRef.current = {
        hasMore,
        nextBefore: before ?? null,
        loading: false,
      };
      useChatStore.getState().loadHistoryPage(sessionId, {
        mode: "prepend",
        messages: collected,
        hasMore,
        ...(before !== undefined ? { nextBefore: before } : {}),
      });
    } catch (error) {
      if (generation !== findHistoryLoadGenerationRef.current) return;
      console.error("[chat-find] failed to load complete history", { sessionId }, error);
      useChatStore.getState().setHistoryLoading(sessionId, false);
      historyStateRef.current = { ...historyStateRef.current, loading: false };
      setFindHistoryFailed(true);
      toast.error("搜索历史消息失败");
    } finally {
      if (generation === findHistoryLoadGenerationRef.current) {
        findHistoryLoadingRef.current = false;
        setFindHistoryLoading(false);
      }
    }
  }, [connected, proxyOnline, sessionId, setHistoryLoading]);

  const cancelFindHistoryLoad = useCallback((): void => {
    findHistoryLoadGenerationRef.current += 1;
    if (!findHistoryLoadingRef.current) return;
    findHistoryLoadingRef.current = false;
    setFindHistoryLoading(false);
    historyStateRef.current = { ...historyStateRef.current, loading: false };
    useChatStore.getState().setHistoryLoading(sessionId, false);
  }, [sessionId]);

  useEffect(() => {
    if (!findOpen || !findQuery || findHistoryFailed) return;
    if (!historyHasMore || historyLoading || findHistoryLoading) return;
    void loadAllHistoryForFind();
  }, [
    findHistoryFailed,
    findHistoryLoading,
    findOpen,
    findQuery,
    historyHasMore,
    historyLoading,
    loadAllHistoryForFind,
  ]);

  useEffect(() => {
    return () => {
      findHistoryLoadGenerationRef.current += 1;
      if (findHistoryLoadingRef.current) {
        useChatStore.getState().setHistoryLoading(sessionId, false);
      }
    };
  }, [sessionId]);

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

  const findMatchIndexes = useMemo(
    () => findChatMessageIndexes(messages, findQuery),
    [findQuery, messages],
  );
  const findMatchIds = useMemo(
    () => findMatchIndexes.map((index) => messages[index].id),
    [findMatchIndexes, messages],
  );
  const findMatchIdSet = useMemo(() => new Set(findMatchIds), [findMatchIds]);
  const activeFindResultIndex = activeFindMessageId
    ? findMatchIds.indexOf(activeFindMessageId)
    : -1;

  useEffect(() => {
    if (!findOpen || !findQuery || findMatchIndexes.length === 0) {
      setActiveFindMessageId(null);
      return;
    }

    setActiveFindMessageId((current) => {
      if (current && findMatchIdSet.has(current)) return current;
      const firstVisibleIndex = virtualizer.getVirtualItems()[0]?.index ?? 0;
      const visibleResultPosition = findMatchIndexes.findIndex(
        (messageIndex) => messageIndex >= firstVisibleIndex,
      );
      const resultPosition = visibleResultPosition >= 0 ? visibleResultPosition : 0;
      return messages[findMatchIndexes[resultPosition]]?.id ?? null;
    });
  }, [findMatchIdSet, findMatchIndexes, findOpen, findQuery, messages, virtualizer]);

  useLayoutEffect(() => {
    if (!activeFindMessageId) return;
    const messageIndex = messages.findIndex((message) => message.id === activeFindMessageId);
    if (messageIndex < 0) return;
    virtualizer.scrollToIndex(messageIndex, { align: "center", behavior: "auto" });
  }, [activeFindMessageId, messages, virtualizer]);

  const navigateFindResult = useCallback(
    (direction: "previous" | "next"): void => {
      if (findMatchIds.length === 0) return;
      const currentIndex = activeFindMessageId ? findMatchIds.indexOf(activeFindMessageId) : -1;
      const nextIndex =
        direction === "next"
          ? (currentIndex + 1 + findMatchIds.length) % findMatchIds.length
          : (currentIndex - 1 + findMatchIds.length) % findMatchIds.length;
      setActiveFindMessageId(findMatchIds[nextIndex]);
    },
    [activeFindMessageId, findMatchIds],
  );

  const openFind = useCallback(() => {
    setFindHistoryFailed(false);
    setFindOpen(true);
  }, []);
  const closeFind = useCallback(() => {
    cancelFindHistoryLoad();
    setFindOpen(false);
    setActiveFindMessageId(null);
  }, [cancelFindHistoryLoad]);
  const previousFindResult = useCallback(
    () => navigateFindResult("previous"),
    [navigateFindResult],
  );
  const nextFindResult = useCallback(() => navigateFindResult("next"), [navigateFindResult]);
  const findShortcuts = useChatFindShortcuts({
    open: findOpen,
    openRequest: findRequest,
    onOpen: openFind,
    onClose: closeFind,
    onPrevious: previousFindResult,
    onNext: nextFindResult,
  });

  const handleFindQueryChange = useCallback(
    (query: string): void => {
      setFindQuery(query);
      setFindHistoryFailed(false);
      if (!query) {
        cancelFindHistoryLoad();
        setActiveFindMessageId(null);
      }
    },
    [cancelFindHistoryLoad],
  );

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
    setFindOpen(false);
    setFindQuery("");
    setActiveFindMessageId(null);
    setFindHistoryLoading(false);
    setFindHistoryFailed(false);
    findHistoryLoadingRef.current = false;
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
    if (findOpen && findQuery) return;
    if (preservePrependRef.current) return;
    const followLiveVoiceTranscript = isLiveVoiceTranscript(lastMsg);
    if (isAtBottomRef.current || followLiveVoiceTranscript) {
      traceJsonScrollRef.current(
        followLiveVoiceTranscript ? "follow-voice-transcript" : "follow-output",
      );
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
  }, [findOpen, findQuery, messages.length, lastMsg?.text]);

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
  const findLoading = Boolean(findQuery) && (findHistoryLoading || historyLoading);

  if (messages.length === 0 && !hasPendingApprovals) {
    return (
      <div className="relative h-full">
        <EmptyState variant="no-messages" />
        {findOpen ? (
          <ChatFindBar
            query={findQuery}
            resultIndex={activeFindResultIndex}
            resultCount={findMatchIds.length}
            focusRequest={findShortcuts.focusRequest}
            loading={findLoading}
            onQueryChange={handleFindQueryChange}
            onPrevious={previousFindResult}
            onNext={nextFindResult}
            onClose={findShortcuts.closeFind}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 relative min-h-0">
        {findOpen ? (
          <ChatFindBar
            query={findQuery}
            resultIndex={activeFindResultIndex}
            resultCount={findMatchIds.length}
            focusRequest={findShortcuts.focusRequest}
            loading={findLoading}
            onQueryChange={handleFindQueryChange}
            onPrevious={previousFindResult}
            onNext={nextFindResult}
            onClose={findShortcuts.closeFind}
          />
        ) : null}
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
                        findState={
                          message?.id === activeFindMessageId
                            ? "active"
                            : message && findMatchIdSet.has(message.id)
                              ? "match"
                              : undefined
                        }
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
          className={findOpen ? "top-14" : undefined}
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
