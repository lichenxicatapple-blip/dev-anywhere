import { useState, useRef, useCallback } from "react";
import { View, Text, ScrollView, Button, Input } from "@tarojs/components";
import Taro from "@tarojs/taro";
import "./index.css";

interface Message {
  id: number;
  text: string;
  role: "user" | "assistant";
  // 动画方案标记
  animMode: "keyframes" | "transition" | "api";
  // tt.createAnimation 导出数据
  animData?: Record<string, unknown>;
}

let msgId = 0;

// 模拟 Claude 流式输出
const CLAUDE_REPLIES = [
  "Let me analyze this project structure for you.",
  "The monorepo uses pnpm workspaces with four packages: shared, proxy, relay, and feishu.",
  "I can see the relay server handles WebSocket connections between the proxy and mobile clients.",
  "This is a well-structured TypeScript project. The shared package defines 16 MessageEnvelope types covering chat, tool, session, and system categories.",
];

export default function SpikeBubbleAnim() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [animMode, setAnimMode] = useState<"keyframes" | "transition" | "api">("keyframes");
  const scrollRef = useRef<string>("");
  const replyIdx = useRef(0);

  const scrollToBottom = useCallback(() => {
    scrollRef.current = `msg-${msgId}`;
  }, []);

  const addMessage = useCallback(
    (role: "user" | "assistant", text: string) => {
      msgId++;
      const msg: Message = { id: msgId, text, role, animMode };

      // tt.createAnimation 方案：创建动画实例
      if (animMode === "api") {
        const anim = Taro.createAnimation({
          duration: 350,
          timingFunction: "ease-out",
        });
        // 初始状态在 CSS 中设置为 opacity:0 translateY(20px)
        // 动画到最终状态
        anim.opacity(1).translateY(0).step();
        msg.animData = anim.export();
      }

      setMessages((prev) => [...prev, msg]);
      setTimeout(scrollToBottom, 50);
    },
    [animMode, scrollToBottom],
  );

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText("");
    addMessage("user", text);

    // 模拟 Claude 回复
    setTimeout(() => {
      const reply = CLAUDE_REPLIES[replyIdx.current % CLAUDE_REPLIES.length];
      replyIdx.current++;
      addMessage("assistant", reply);
    }, 600);
  }, [inputText, addMessage]);

  // 批量添加消息测试 ScrollView 内动画表现
  const handleBatch = useCallback(() => {
    const batch = [
      { role: "user" as const, text: "Show me the project stats" },
      { role: "assistant" as const, text: "Phase 1-5 complete. 13 plans executed. Currently entering Phase 6." },
      { role: "user" as const, text: "What about the relay server?" },
      { role: "assistant" as const, text: "The relay bridges local proxy and Feishu mini program via WebSocket. Supports auto-reconnect, message buffering, and sequence-numbered delivery." },
    ];
    batch.forEach((b, i) => {
      setTimeout(() => addMessage(b.role, b.text), i * 400);
    });
  }, [addMessage]);

  return (
    <View className="container">
      {/* 动画模式选择 */}
      <View className="mode-row">
        {(["keyframes", "transition", "api"] as const).map((m) => (
          <Button
            key={m}
            className={`mode-btn ${animMode === m ? "active" : ""}`}
            size="mini"
            onClick={() => setAnimMode(m)}
          >
            {m === "keyframes" ? "@keyframes" : m === "transition" ? "CSS transition" : "tt.createAnimation"}
          </Button>
        ))}
      </View>
      <View className="mode-row">
        <Button className="batch-btn" size="mini" onClick={handleBatch}>
          Batch 4 msgs
        </Button>
        <Text className="hint">current: {animMode}</Text>
      </View>

      {/* 消息列表 */}
      <ScrollView
        className="chat-scroll"
        scrollY
        scrollIntoView={scrollRef.current}
        scrollWithAnimation
      >
        {messages.map((msg) => (
          <View
            key={msg.id}
            id={`msg-${msg.id}`}
            className={`bubble-row ${msg.role}`}
          >
            <View
              className={`bubble ${msg.role} anim-${msg.animMode}`}
              animation={msg.animMode === "api" ? msg.animData : undefined}
            >
              <Text className="bubble-text">{msg.text}</Text>
            </View>
          </View>
        ))}
        {messages.length === 0 && (
          <View className="empty-state">
            <Text className="empty-text">Send a message to test bubble animation</Text>
            <Text className="empty-hint">Try each animation mode and compare</Text>
          </View>
        )}
      </ScrollView>

      {/* 输入栏 */}
      <View className="input-bar">
        <Input
          className="input-field"
          value={inputText}
          onInput={(e) => setInputText(e.detail.value)}
          onConfirm={handleSend}
          placeholder="Type a message..."
          confirmType="send"
        />
        <Button className="send-btn" size="mini" onClick={handleSend}>
          Send
        </Button>
      </View>
    </View>
  );
}
