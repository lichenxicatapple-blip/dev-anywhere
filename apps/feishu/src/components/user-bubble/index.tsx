// 用户消息气泡，右对齐蓝色背景
import { View, Text } from "@tarojs/components";
import "./index.css";

interface UserBubbleProps {
  text: string;
  timestamp?: number;
  showTimestamp: boolean;
  onToggleTimestamp: () => void;
}

export function UserBubble({ text, timestamp, showTimestamp, onToggleTimestamp }: UserBubbleProps) {
  return (
    <View className="user-bubble-wrapper" onClick={onToggleTimestamp}>
      <View className="user-bubble bubble-enter-user">
        <Text selectable className="user-bubble-text">{text}</Text>
      </View>
      {showTimestamp && timestamp && (
        <View className="user-bubble-time-row">
          <Text className="user-bubble-time">
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      )}
    </View>
  );
}
