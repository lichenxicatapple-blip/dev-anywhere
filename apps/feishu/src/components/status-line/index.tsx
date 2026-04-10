// 会话状态指示条，4px 高度色条，根据状态展示不同颜色和动画
import { View } from "@tarojs/components";
import "./index.css";

interface StatusLineProps {
  state: "idle" | "working" | "waiting_approval" | "terminated";
}

export function StatusLine({ state }: StatusLineProps) {
  return (
    <View className={`status-line status-line-${state}`}>
      {state === "working" && <View className="status-line-sweep" />}
    </View>
  );
}
