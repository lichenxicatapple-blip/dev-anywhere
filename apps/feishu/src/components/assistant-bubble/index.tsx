// 助手消息气泡，左对齐灰色背景，支持流式游标
import { View, Text } from "@tarojs/components";
import type { ToolCallInfo } from "@/stores/chat-store";
import "./index.css";

interface AssistantBubbleProps {
  text: string;
  isPartial: boolean;
  toolCalls: ToolCallInfo[];
  timestamp?: number;
  showTimestamp: boolean;
  onToggleTimestamp: () => void;
}

export function AssistantBubble({
  text,
  isPartial,
  toolCalls,
  timestamp,
  showTimestamp,
  onToggleTimestamp,
}: AssistantBubbleProps) {
  return (
    <View className="assistant-bubble-wrapper" onClick={onToggleTimestamp}>
      <View className="assistant-bubble bubble-enter-assistant">
        <Text selectable className="assistant-bubble-text">
          {text}
          {isPartial && <Text className="assistant-streaming-cursor">|</Text>}
        </Text>
        {toolCalls.map((tc, i) => (
          <View key={i} className="assistant-tool-line">
            <Text className="assistant-tool-text">
              [Tool: {tc.toolName}]{tc.collapsed ? "" : ` ${tc.output ?? ""}`}
            </Text>
          </View>
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
