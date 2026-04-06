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
  console.log("[spike] Index page rendered");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  const [socketTask, setSocketTask] = useState<Taro.SocketTask | null>(null);

  const handleConnect = useCallback(() => {
    // 飞书小程序的 connectSocket 返回 Promise<SocketTask>
    Taro.connectSocket({ url: "ws://localhost:9099" }).then((task) => {
      task.onOpen(() => {
        setStatus("connected");
      });

      task.onMessage((res) => {
        setMessages((prev) => [...prev, res.data as string]);
      });

      task.onClose(() => {
        setStatus("disconnected");
        setSocketTask(null);
      });

      task.onError(() => {
        setStatus("error");
      });

      setSocketTask(task);
    }).catch(() => {
      setStatus("error");
    });
  }, []);

  const handleSend = useCallback(() => {
    if (!inputValue.trim() || !socketTask) return;
    const payload = JSON.stringify({ text: inputValue, ts: Date.now() });
    socketTask.send({ data: payload });
    setInputValue("");
  }, [inputValue, socketTask]);

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
