// JSON 模式聊天气泡列表，使用 ScrollView 原生滚动组件
// ScrollView 支持嵌套滚动隔离，内层 ScrollView scrollX 不会与外层 scrollY 冲突
import { useRef, useEffect, useCallback, useState } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { ChatMessage, QuotedMessage } from "@/stores/chat-store";
import { UserBubble } from "@/components/user-bubble";
import { AssistantBubble } from "@/components/assistant-bubble";
import "./index.css";

interface ChatBubbleListProps {
  messages: ChatMessage[];
  hasMoreHistory?: boolean;
  onLoadMore?: () => void;
  isWorking: boolean;
  onScrollThresholdChange: (isNearBottom: boolean) => void;
  onToggleToolCollapse?: (messageId: string, toolIndex: number) => void;
  onQuote?: (quote: QuotedMessage) => void;
}

const BOTTOM_ANCHOR_ID = "chat-bottom-anchor";

export function ChatBubbleList({
  messages,
  hasMoreHistory,
  onLoadMore,
  isWorking,
  onScrollThresholdChange,
  onToggleToolCollapse,
  onQuote,
}: ChatBubbleListProps) {
  const isNearBottomRef = useRef(true);
  const [visibleTimestamps, setVisibleTimestamps] = useState<Set<string>>(new Set());
  const [scrollIntoViewId, setScrollIntoViewId] = useState("");
  const [scrollTopState, setScrollTopState] = useState(0);
  // ScrollView 的 scrollTop 需要变化才能触发滚动，用 toggle 强制刷新
  const scrollToggleRef = useRef(0);

  const handleToggleTimestamp = useCallback((msgId: string) => {
    setVisibleTimestamps((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }, []);

  const handleScroll = useCallback(
    (e: { detail: { scrollTop: number; scrollHeight: number; clientHeight?: number } }) => {
      const { scrollTop, scrollHeight } = e.detail;
      // ScrollView 的 detail 可能不含 clientHeight，回退到容器高度估算
      const clientHeight = e.detail.clientHeight || 0;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const nearBottom = clientHeight === 0 ? true : distanceFromBottom < 50;
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        onScrollThresholdChange(nearBottom);
      }
    },
    [onScrollThresholdChange],
  );

  // 新消息到达时，如果在底部附近则自动滚到底
  useEffect(() => {
    if (isNearBottomRef.current) {
      setScrollIntoViewId(BOTTOM_ANCHOR_ID);
      // 清除 scrollIntoView 以便下次再触发同一 id
      const timer = setTimeout(() => setScrollIntoViewId(""), 100);
      return () => clearTimeout(timer);
    }
  }, [messages.length]);

  const handleLoadMore = useCallback(() => {
    // ScrollView 的滚动位置补偿由原生组件自动处理
    // 加载更多后不需要手动调整 scrollTop
    onLoadMore?.();
  }, [onLoadMore]);

  // 滚动到底部的命令式方法，供外部或初始化调用
  const scrollToBottom = useCallback(() => {
    setScrollIntoViewId(BOTTOM_ANCHOR_ID);
    setTimeout(() => setScrollIntoViewId(""), 100);
  }, []);

  // 初次加载时滚到底部
  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ScrollView
      className="chat-bubble-list"
      scrollY
      scrollWithAnimation
      scrollIntoView={scrollIntoViewId}
      onScroll={handleScroll}
      enhanced
      showScrollbar={false}
    >
      {hasMoreHistory && (
        <View className="chat-load-more">
          <Text className="chat-load-more-text" onClick={handleLoadMore}>Load earlier messages</Text>
        </View>
      )}
      {messages.map((msg) => (
        <View key={msg.id} className={`chat-bubble-row ${msg.role}`}>
          {msg.role === "user" ? (
            <UserBubble
              text={msg.text}
              timestamp={msg.timestamp}
              showTimestamp={visibleTimestamps.has(msg.id)}
              onToggleTimestamp={() => handleToggleTimestamp(msg.id)}
              quotedMessage={msg.quotedMessage}
              onQuote={onQuote}
            />
          ) : (
            <AssistantBubble
              text={msg.text}
              isPartial={msg.isPartial}
              toolCalls={msg.toolCalls}
              timestamp={msg.timestamp}
              showTimestamp={visibleTimestamps.has(msg.id)}
              onToggleTimestamp={() => handleToggleTimestamp(msg.id)}
              onToggleToolCollapse={(toolIndex) => onToggleToolCollapse?.(msg.id, toolIndex)}
              onQuote={onQuote}
            />
          )}
        </View>
      ))}
      {isWorking && messages.length > 0 && !(messages[messages.length - 1].role === "assistant" && messages[messages.length - 1].isPartial) && (
        <View className="chat-bubble-row assistant">
          <View className="thinking-indicator">
            <View className="thinking-dot" />
            <View className="thinking-dot" />
            <View className="thinking-dot" />
          </View>
        </View>
      )}
      <View id={BOTTOM_ANCHOR_ID} className="chat-bubble-bottom-anchor" />
    </ScrollView>
  );
}
