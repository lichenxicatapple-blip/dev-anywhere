// 用户消息气泡，右对齐蓝色背景，支持长按引用和引用块显示
import { useState, useCallback, useRef } from "react";
import { View, Text } from "@tarojs/components";
import type { QuotedMessage } from "@/stores/chat-store";
import "./index.css";

interface UserBubbleProps {
  text: string;
  timestamp?: number;
  showTimestamp: boolean;
  onToggleTimestamp: () => void;
  quotedMessage?: QuotedMessage;
  onQuote?: (quote: QuotedMessage) => void;
}

export function UserBubble({
  text,
  timestamp,
  showTimestamp,
  onToggleTimestamp,
  quotedMessage,
  onQuote,
}: UserBubbleProps) {
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
    onQuote?.({ from: "user", text });
  }, [onQuote, text]);

  const handleDismissMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  // 提取不含引用 XML 标签的纯文本
  const displayText = text.replace(/<quote from="[^"]*">[^<]*<\/quote>\n?/, "");

  return (
    <View
      className="user-bubble-wrapper"
      onClick={onToggleTimestamp}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <View className="user-bubble bubble-enter-user">
        {quotedMessage && (
          <View className="user-bubble-quoted-block">
            <View className="user-bubble-quoted-line" />
            <View className="user-bubble-quoted-content">
              <Text className="user-bubble-quoted-source">
                {quotedMessage.from === "assistant" ? "Claude:" : "You:"}
              </Text>
              <Text className="user-bubble-quoted-text">{quotedMessage.text}</Text>
            </View>
          </View>
        )}
        <Text selectable className="user-bubble-text">{displayText}</Text>
      </View>
      {showTimestamp && timestamp && (
        <View className="user-bubble-time-row">
          <Text className="user-bubble-time">
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      )}

      {showContextMenu && (
        <View className="user-bubble-context-overlay" onClick={handleDismissMenu}>
          <View
            className="user-bubble-context-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <View className="user-bubble-context-item" onClick={handleQuote}>
              <Text className="user-bubble-context-item-text">Quote</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
