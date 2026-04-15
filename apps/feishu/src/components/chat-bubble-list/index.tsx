// JSON 模式聊天气泡列表，使用 ScrollView 原生滚动组件
// ScrollView 解决嵌套滚动隔离，内层 ScrollView scrollX 不会与外层 scrollY 冲突
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
  const isLoadingMoreRef = useRef(false);
  const anchorMsgIdRef = useRef("");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [scrollToView, setScrollToView] = useState("");
  const [scrollAnimate, setScrollAnimate] = useState(true);
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

  // 统一用 ScrollView scrollIntoView prop 处理滚动，兼容 H5 和小程序
  useEffect(() => {
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      // 锚定到 load more 前的第一条可见消息，无动画瞬间跳转
      if (anchorMsgIdRef.current) {
        const anchorId = anchorMsgIdRef.current;
        anchorMsgIdRef.current = "";
        setScrollAnimate(false);
        setScrollToView("");
        setTimeout(() => {
          setScrollToView(anchorId);
          // 恢复动画，下次新消息滚动时使用
          setTimeout(() => setScrollAnimate(true), 100);
        }, 50);
      }
      return;
    }

    // 新消息或初始加载时自动滚到底
    if (isNearBottomRef.current && messages.length > 0) {
      setScrollToView("");
      setTimeout(() => setScrollToView("chat-bottom-anchor"), 50);
    }
  }, [messages.length]);

  const handleLoadMore = useCallback(() => {
    // 记录当前第一条可见消息 ID 作为锚点
    if (messagesRef.current.length > 0) {
      anchorMsgIdRef.current = messagesRef.current[0].id;
    }
    isLoadingMoreRef.current = true;
    onLoadMore?.();
  }, [onLoadMore]);

  return (
    <ScrollView
      className="chat-bubble-list"
      scrollY
      showScrollbar={false}
      scrollIntoView={scrollToView}
      scrollWithAnimation={scrollAnimate}
      onScroll={handleScroll}
    >
      {hasMoreHistory && (
        <View className="chat-load-more">
          <Text className="chat-load-more-text" onClick={handleLoadMore}>Load earlier messages</Text>
        </View>
      )}
      {messages.map((msg) => (
        <View key={msg.id} id={msg.id} className={`chat-bubble-row ${msg.role}`}>
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
      <View id="chat-bottom-anchor" className="chat-bubble-bottom-anchor" />
    </ScrollView>
  );
}
