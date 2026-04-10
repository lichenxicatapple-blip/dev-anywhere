// Proxy 列表项：名称 + 在线/离线状态圆点，深色终端主题卡片
import { View, Text } from "@tarojs/components";
import type { ProxyInfo } from "@cc-anywhere/shared";
import "./index.css";

interface ProxyListItemProps {
  proxy: ProxyInfo;
  online: boolean;
  onSelect: () => void;
}

export function ProxyListItem({ proxy, online, onSelect }: ProxyListItemProps) {
  return (
    <View className="proxy-item" onClick={onSelect}>
      <Text className="proxy-name">{proxy.name || proxy.proxyId}</Text>
      <View className={`proxy-dot ${online ? "online" : "offline"}`} />
    </View>
  );
}
