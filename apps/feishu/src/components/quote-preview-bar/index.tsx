// 引用预览条：显示在输入栏上方，展示被引用消息的摘要
import { View, Text } from "@tarojs/components";
import type { QuotedMessage } from "@/stores/chat-store";
import "./index.css";

interface QuotePreviewBarProps {
  quote: QuotedMessage;
  onCancel: () => void;
}

export function QuotePreviewBar({ quote, onCancel }: QuotePreviewBarProps) {
  const sourceLabel = quote.from === "assistant" ? "Claude:" : "You:";

  return (
    <View className="quote-preview-bar">
      <View className="quote-preview-indicator" />
      <View className="quote-preview-content">
        <Text className="quote-preview-source">{sourceLabel}</Text>
        <Text className="quote-preview-text">{quote.text}</Text>
      </View>
      <View className="quote-preview-close" onClick={onCancel}>
        <Text className="quote-preview-close-icon">x</Text>
      </View>
    </View>
  );
}
