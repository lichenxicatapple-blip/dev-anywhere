// 助手消息气泡，左对齐灰色背景，支持流式游标，工具调用使用 ToolCallCard
import { View, Text } from "@tarojs/components";
import type { ToolCallInfo } from "@/stores/chat-store";
import { ToolCallCard } from "@/components/tool-call-card";
import "./index.css";

interface AssistantBubbleProps {
  text: string;
  isPartial: boolean;
  toolCalls: ToolCallInfo[];
  timestamp?: number;
  showTimestamp: boolean;
  onToggleTimestamp: () => void;
  onToggleToolCollapse?: (toolIndex: number) => void;
}

export function AssistantBubble({
  text,
  isPartial,
  toolCalls,
  timestamp,
  showTimestamp,
  onToggleTimestamp,
  onToggleToolCollapse,
}: AssistantBubbleProps) {
  return (
    <View className="assistant-bubble-wrapper" onClick={onToggleTimestamp}>
      <View className="assistant-bubble bubble-enter-assistant">
        <Text selectable className="assistant-bubble-text">
          {text}
          {isPartial && <Text className="assistant-streaming-cursor">|</Text>}
        </Text>
        {toolCalls.map((tc, i) => (
          <ToolCallCard
            key={i}
            toolCall={tc}
            onToggleCollapse={() => onToggleToolCollapse?.(i)}
          />
        ))}
      </View>
      {showTimestamp && timestamp && (
        <View className="assistant-bubble-time-row">
          <Text className="assistant-bubble-time">
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      )}
    </View>
  );
}
