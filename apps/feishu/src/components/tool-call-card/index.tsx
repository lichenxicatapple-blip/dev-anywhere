// 工具调用卡片，默认折叠显示工具名和参数摘要，点击展开完整参数和输出
import { View, Text } from "@tarojs/components";
import type { ToolCallInfo } from "@/stores/chat-store";
import { summarizeToolInput } from "@/utils/summarize-tool-input";
import "./index.css";

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
  onToggleCollapse: () => void;
}

export function ToolCallCard({ toolCall, onToggleCollapse }: ToolCallCardProps) {
  const summary = summarizeToolInput(toolCall.toolName, toolCall.input);
  const paramSummary =
    summary.summary.length > 40 ? summary.summary.slice(0, 40) + "..." : summary.summary;

  if (toolCall.collapsed) {
    return (
      <View className="tool-call-card tool-call-collapsed" onClick={onToggleCollapse}>
        <Text className="tool-call-icon">&#9874;</Text>
        <Text className="tool-call-name">{toolCall.toolName}</Text>
        <Text className="tool-call-summary">{paramSummary}</Text>
      </View>
    );
  }

  return (
    <View className="tool-call-card tool-call-expanded" onClick={onToggleCollapse}>
      <View className="tool-call-header">
        <Text className="tool-call-icon">&#9874;</Text>
        <Text className="tool-call-name">{toolCall.toolName}</Text>
      </View>
      <View className="tool-call-params">
        <Text selectable className="tool-call-params-text">
          {JSON.stringify(toolCall.input, null, 2)}
        </Text>
      </View>
      {toolCall.output != null && (
        <View className="tool-call-output">
          <Text className="tool-call-output-label">Result:</Text>
          <Text selectable className="tool-call-output-text">{toolCall.output}</Text>
        </View>
      )}
    </View>
  );
}
