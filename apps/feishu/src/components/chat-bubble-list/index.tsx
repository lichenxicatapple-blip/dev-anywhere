// JSON 模式聊天气泡列表，使用 View overflow 而非 ScrollView
import { useRef, useEffect, useCallback, useState } from "react";
import { View } from "@tarojs/components";
import type { ChatMessage } from "@/stores/chat-store";
import { UserBubble } from "@/components/user-bubble";
import { AssistantBubble } from "@/components/assistant-bubble";
import "./index.css";

interface ChatBubbleListProps {
  messages: ChatMessage[];
  isWorking: boolean;
  onScrollThresholdChange: (isNearBottom: boolean) => void;
  onToggleToolCollapse?: (messageId: string, toolIndex: number) => void;
}

export function ChatBubbleList({
  messages,
  isWorking: _isWorking,
  onScrollThresholdChange,
  onToggleToolCollapse,
}: ChatBubbleListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
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

  // 新消息到达时，如果在底部附近则自动滚到底
  useEffect(() => {
    if (isNearBottomRef.current && bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [messages.length]);

  return (
    <View
      className="chat-bubble-list"
      ref={containerRef}
      onScroll={handleScroll}
    >
      {messages.map((msg) => (
        <View key={msg.id} className={`chat-bubble-row ${msg.role}`}>
          {msg.role === "user" ? (
            <UserBubble
              text={msg.text}
              timestamp={msg.timestamp}
              showTimestamp={visibleTimestamps.has(msg.id)}
              onToggleTimestamp={() => handleToggleTimestamp(msg.id)}
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
            />
          )}
        </View>
      ))}
      <View ref={bottomAnchorRef} className="chat-bubble-bottom-anchor" />
    </View>
  );
}
