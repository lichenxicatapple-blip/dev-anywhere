// 回到底部浮动按钮，用户上滑超过阈值时显示，点击滚到底部
import { View, Text } from "@tarojs/components";
import "./index.css";

interface BackToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function BackToBottomButton({ visible, onClick }: BackToBottomButtonProps) {
  return (
    <View
      className={`back-to-bottom ${visible ? "back-to-bottom-visible" : "back-to-bottom-hidden"}`}
      onClick={onClick}
    >
      <Text className="back-to-bottom-arrow">&#8595;</Text>
    </View>
  );
}
