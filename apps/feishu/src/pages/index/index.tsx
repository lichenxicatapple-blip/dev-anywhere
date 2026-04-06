import { useState, useCallback } from "react";
import { View, Text, Input, Button } from "@tarojs/components";
import Taro from "@tarojs/taro";
import "./index.css";

type ConnectionStatus = "disconnected" | "connected" | "error";

/**
 * Spike 页面：验证 Taro + tt.connectSocket 的 WebSocket 通信能力。
 * 连接本地 echo server，发送 JSON，接收回显的 JSON。
 */
export default function Index() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  const handleConnect = useCallback(() => {
    Taro.connectSocket({ url: "ws://localhost:9099" });

    Taro.onSocketOpen(() => {
      setStatus("connected");
    });

    Taro.onSocketMessage((res) => {
      setMessages((prev) => [...prev, res.data as string]);
    });

    Taro.onSocketClose(() => {
      setStatus("disconnected");
    });

    Taro.onSocketError(() => {
      setStatus("error");
    });
  }, []);

  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    const payload = JSON.stringify({ text: inputValue, ts: Date.now() });
    Taro.sendSocketMessage({ data: payload });
    setInputValue("");
  }, [inputValue]);

  return (
    <View className="container">
      <Text className="title">CC Anywhere - WebSocket Spike</Text>

      <View className="status-bar">
        <Text className={`status status-${status}`}>{status}</Text>
      </View>

      <Button
        className="connect-btn"
        onClick={handleConnect}
        disabled={status === "connected"}
      >
        Connect
      </Button>

      <View className="input-area">
        <Input
          className="message-input"
          value={inputValue}
          onInput={(e) => setInputValue(e.detail.value)}
          placeholder="Type a message..."
          disabled={status !== "connected"}
        />
        <Button
          className="send-btn"
          onClick={handleSend}
          disabled={status !== "connected"}
        >
          Send
        </Button>
      </View>

      <View className="message-list">
        <Text className="list-title">Received Messages:</Text>
        {messages.map((msg, i) => (
          <View key={i} className="message-item">
            <Text>{msg}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
