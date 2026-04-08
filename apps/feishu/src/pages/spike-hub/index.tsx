import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import "./index.css";

const SPIKES = [
  { name: "Proxy Select (Typewriter)", path: "/pages/spike-typewriter/index" },
  { name: "Session List", path: "/pages/spike-session-list/index" },
  { name: "Chat - JSON Mode", path: "/pages/spike-chat-json/index" },
  { name: "Chat - PTY Mode", path: "/pages/spike-chat-pty/index" },
  { name: "Bubble Animation", path: "/pages/spike-bubble-anim/index" },
  { name: "Terminal Render", path: "/pages/spike-render/index" },
  { name: "Command & File Picker", path: "/pages/spike-picker/index" },
];

export default function SpikeHub() {
  return (
    <View className="page">
      <View className="header">
        <Text className="title">CC Anywhere Spikes</Text>
        <Text className="subtitle">Tap to preview each page</Text>
      </View>
      <View className="list">
        {SPIKES.map((s, i) => (
          <View
            key={i}
            className="item"
            onClick={() => Taro.navigateTo({ url: s.path })}
          >
            <Text className="item-index">{i + 1}</Text>
            <Text className="item-name">{s.name}</Text>
            <Text className="item-arrow">{">"}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
