// 助手消息气泡，左对齐灰色背景，支持流式游标，工具调用使用 ToolCallCard，支持长按引用
import { useState, useCallback, useRef } from "react";
import { View, Text } from "@tarojs/components";
import type { ToolCallInfo, QuotedMessage } from "@/stores/chat-store";
import { ToolCallCard } from "@/components/tool-call-card";
import { MarkdownView } from "@/components/markdown-view";
import "@/components/markdown-view/index.css";
import "./index.css";

interface AssistantBubbleProps {
  text: string;
  isPartial: boolean;
  toolCalls: ToolCallInfo[];
  timestamp?: number;
  showTimestamp: boolean;
  onToggleTimestamp: () => void;
  onToggleToolCollapse?: (toolIndex: number) => void;
  onQuote?: (quote: QuotedMessage) => void;
}

export function AssistantBubble({
  text,
  isPartial,
  toolCalls,
  timestamp,
  showTimestamp,
  onToggleTimestamp,
  onToggleToolCollapse,
  onQuote,
}: AssistantBubbleProps) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      setShowContextMenu(true);
    }, 500);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleQuote = useCallback(() => {
    setShowContextMenu(false);
    onQuote?.({ from: "assistant", text });
  }, [onQuote, text]);

  const handleDismissMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  return (
    <View
      className="assistant-bubble-wrapper"
      onClick={onToggleTimestamp}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <View className="assistant-bubble bubble-enter-assistant">
        <MarkdownView text={text} className="assistant-bubble-text" />
        {isPartial && <Text className="assistant-streaming-cursor">|</Text>}
        {toolCalls.map((tc, i) => (
          <ToolCallCard
            key={i}
            toolCall={tc}
            onToggleCollapse={() => onToggleToolCollapse?.(i)}
          />
        ))}
      </View>
      {showTimestamp && timestamp != null && timestamp > 0 && (
        <View className="assistant-bubble-time-row">
          <Text className="assistant-bubble-time">
            {new Date(timestamp!).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      )}

      {showContextMenu && (
        <View className="assistant-bubble-context-overlay" onClick={handleDismissMenu}>
          <View
            className="assistant-bubble-context-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <View className="assistant-bubble-context-item" onClick={handleQuote}>
              <Text className="assistant-bubble-context-item-text">Quote</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
