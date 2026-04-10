// 安全区域自定义导航栏，用于 navigationStyle: "custom" 的页面
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { ReactNode } from "react";
import "./index.css";

interface SafeAreaHeaderProps {
  title: string;
  onBack?: () => void;
  rightSlot?: ReactNode;
  statusBarHeight: number;
  transparent?: boolean;
}

export function SafeAreaHeader({
  title,
  onBack,
  rightSlot,
  statusBarHeight,
  transparent = false,
}: SafeAreaHeaderProps) {
  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      Taro.navigateBack();
    }
  };

  return (
    <View
      className={`safe-area-header ${transparent ? "safe-area-header-transparent" : ""}`}
    >
      <View style={{ height: `${statusBarHeight}px` }} />
      <View className="safe-area-header-bar">
        <View className="safe-area-header-back" onClick={handleBack}>
          <Text className="safe-area-header-back-icon">{"<"}</Text>
        </View>
        <Text className="safe-area-header-title">{title}</Text>
        <View className="safe-area-header-right">
          {rightSlot}
        </View>
      </View>
    </View>
  );
}
