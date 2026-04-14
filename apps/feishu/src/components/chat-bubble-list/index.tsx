// JSON 模式聊天气泡列表，使用 View overflow 而非 ScrollView
import { useRef, useEffect, useCallback, useState } from "react";
import { View, Text } from "@tarojs/components";
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

export function ChatBubbleList({
  messages,
  hasMoreHistory,
  onLoadMore,
  isWorking,
  onScrollThresholdChange,
  onToggleToolCollapse,
  onQuote,
}: ChatBubbleListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const [visibleTimestamps, setVisibleTimestamps] = useState<Set<string>>(new Set());

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
    (e: { currentTarget: { scrollTop: number; scrollHeight: number; clientHeight: number } }) => {
      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const nearBottom = distanceFromBottom < 50;
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        onScrollThresholdChange(nearBottom);
      }
    },
    [onScrollThresholdChange],
  );

  // 加载更多历史后，补偿 scrollTop 保持当前查看位置不变
  useEffect(() => {
    const el = containerRef.current;
    if (!el || prevScrollHeightRef.current === 0) return;
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) {
      el.scrollTop += delta;
    }
    prevScrollHeightRef.current = 0;
  });

  // 新消息到达时，如果在底部附近则自动滚到底
  useEffect(() => {
    if (isNearBottomRef.current && bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleLoadMore = useCallback(() => {
    const el = containerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    onLoadMore?.();
  }, [onLoadMore]);

  return (
    <View
      className="chat-bubble-list"
      ref={containerRef}
      // @ts-expect-error Taro View 类型未声明 onScroll，但飞书运行时支持
      onScroll={handleScroll}
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
      <View ref={bottomAnchorRef} className="chat-bubble-bottom-anchor" />
    </View>
  );
}
