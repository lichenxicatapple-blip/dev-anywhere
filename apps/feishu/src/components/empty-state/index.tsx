// 通用空状态占位组件，居中标题、副标题和可选的 CTA 按钮
import { View, Text } from "@tarojs/components";
import "./index.css";

interface EmptyStateProps {
  title: string;
  subtitle: string;
  ctaText?: string;
  onCta?: () => void;
}

export function EmptyState({ title, subtitle, ctaText, onCta }: EmptyStateProps) {
  return (
    <View className="empty-state">
      <Text className="empty-state-title">{title}</Text>
      <Text className="empty-state-subtitle">{subtitle}</Text>
      {ctaText && onCta && (
        <View className="empty-state-cta" onClick={onCta}>
          <Text className="empty-state-cta-text">{ctaText}</Text>
        </View>
      )}
    </View>
  );
}
