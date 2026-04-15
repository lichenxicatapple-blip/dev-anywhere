// JSON 模式聊天气泡列表，使用 ScrollView 原生滚动组件
// ScrollView 解决嵌套滚动隔离，内层 ScrollView scrollX 不会与外层 scrollY 冲突
// 滚动控制通过 DOM ref 命令式操作，避免 ScrollView 声明式 props 的竞态问题
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

// H5 模式下 Taro ScrollView 渲染为普通 div，通过 DOM query 获取底层元素
function getScrollElement(): HTMLElement | null {
  return document.querySelector(".chat-bubble-list") as HTMLElement | null;
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
  const isNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const prevScrollTopRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
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
    () => {
      const el = getScrollElement();
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const nearBottom = distanceFromBottom < 50;
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        onScrollThresholdChange(nearBottom);
      }
    },
    [onScrollThresholdChange],
  );

  // 消息变化时的滚动处理：合并为单个 effect 避免竞争
  // 两种场景互斥：load more 做位置补偿，新消息做滚到底
  useEffect(() => {
    const el = getScrollElement();
    if (!el) return;

    // 场景 1：load more — 补偿 scrollTop 保持当前查看位置不变
    // 消息可能分多批渲染，每批都需要补偿，直到 delta=0 才结束
    if (prevScrollHeightRef.current > 0) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) {
        el.scrollTop = prevScrollTopRef.current + delta;
        prevScrollTopRef.current = el.scrollTop;
        prevScrollHeightRef.current = el.scrollHeight;
      } else {
        prevScrollHeightRef.current = 0;
        prevScrollTopRef.current = 0;
      }
      return;
    }

    // 场景 2：新消息到达 — 如果在底部附近则自动滚到底
    if (isNearBottomRef.current && bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleLoadMore = useCallback(() => {
    const el = getScrollElement();
    if (el) {
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopRef.current = el.scrollTop;
      isLoadingMoreRef.current = true;
    }
    onLoadMore?.();
  }, [onLoadMore]);

  return (
    <ScrollView
      className="chat-bubble-list"
      scrollY
      enhanced
      showScrollbar={false}
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
    </ScrollView>
  );
}
