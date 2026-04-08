import { useState, useRef, useCallback, useEffect } from "react";
import { View, Text, ScrollView, Input } from "@tarojs/components";
import "./index.css";

type MsgType = "user" | "assistant" | "tool_call" | "tool_approval";

interface Message {
  id: number;
  type: MsgType;
  text: string;
  toolName?: string;
  toolParams?: string;
  isPartial?: boolean;
  approved?: "allow" | "deny" | null;
  expanded?: boolean;
  time?: string;
  showTime?: boolean;
}

let msgId = 0;

const MOCK_MESSAGES: Message[] = [
  { id: ++msgId, type: "user", text: "Fix the WebSocket reconnection bug in relay server", time: "14:32" },
  { id: ++msgId, type: "assistant", text: "I'll investigate the reconnection logic. Let me start by reading the relevant files.", time: "14:32" },
  { id: ++msgId, type: "tool_call", text: "", toolName: "Read", toolParams: "apps/relay/src/server.ts", time: "14:32" },
  { id: ++msgId, type: "tool_call", text: "", toolName: "Bash", toolParams: "grep -n 'reconnect' apps/relay/src/handlers/*.ts", time: "14:33" },
  { id: ++msgId, type: "assistant", text: "Found the issue. The reconnection handler doesn't properly restore the message buffer sequence number after a client reconnects. The seq counter resets to 0 instead of continuing from the last acknowledged sequence.", time: "14:33" },
  { id: ++msgId, type: "tool_approval", text: "", toolName: "Edit", toolParams: 'apps/relay/src/handlers/client.ts\n\n- this.seq = 0\n+ this.seq = lastAckedSeq', time: "14:34" },
  { id: ++msgId, type: "tool_approval", text: "", toolName: "Bash", toolParams: 'rm -rf node_modules && pnpm install', time: "14:34" },
  { id: ++msgId, type: "tool_approval", text: "", toolName: "mcp__db__query", toolParams: '{"database": "production", "query": "SELECT * FROM sessions WHERE status = \'active\'", "limit": 100}', time: "14:35" },
];

function ToolCallCard({ msg, onToggle }: { msg: Message; onToggle: () => void }) {
  return (
    <View className="tool-card" onClick={onToggle}>
      <View className="tool-card-header">
        <Text className="tool-card-icon">[T]</Text>
        <Text className="tool-card-name">{msg.toolName}</Text>
        {!msg.expanded && (
          <Text className="tool-card-params-preview" numberOfLines={1}>{msg.toolParams}</Text>
        )}
      </View>
      {msg.expanded && (
        <View className="tool-card-body">
          <Text className="tool-card-params-full">{msg.toolParams}</Text>
        </View>
      )}
    </View>
  );
}

function ToolApprovalCard({
  msg,
  onApprove,
}: {
  msg: Message;
  onApprove: (action: "allow" | "allowAll" | "deny") => void;
}) {
  const isResolved = msg.approved !== null && msg.approved !== undefined;

  return (
    <View className="approval-card">
      <Text className="approval-title">Tool Approval Required</Text>
      <Text className="approval-tool-name">{msg.toolName}</Text>
      <View className="approval-params-box">
        {msg.toolName === "Bash" ? (
          <View className="bash-command">
            <Text selectable className="bash-prompt">$ </Text>
            <Text selectable className="bash-text">{msg.toolParams}</Text>
          </View>
        ) : msg.toolName === "Edit" ? (
          (msg.toolParams || "").split("\n").map((line, i) => (
            <Text
              key={i}
                           className={`approval-params ${line.startsWith("- ") ? "diff-del" : line.startsWith("+ ") ? "diff-add" : ""}`}
            >
              {line}{"\n"}
            </Text>
          ))
        ) : (
          <Text selectable className="json-fallback">
            {(() => {
              try { return JSON.stringify(JSON.parse(msg.toolParams || ""), null, 2); }
              catch { return msg.toolParams; }
            })()}
          </Text>
        )}
      </View>
      {isResolved ? (
        <View className={`approval-resolved ${msg.approved}`}>
          <Text className="approval-resolved-text">
            {msg.approved === "allow" ? "Allowed" : "Denied"}
          </Text>
        </View>
      ) : (
        <View className="approval-buttons">
          <View className="approval-btn allow" onClick={() => onApprove("allow")}>
            <Text className="approval-btn-text">Allow</Text>
          </View>
          <View className="approval-btn allow-all" onClick={() => onApprove("allowAll")}>
            <Text className="approval-btn-text">Allow All</Text>
          </View>
          <View className="approval-btn deny" onClick={() => onApprove("deny")}>
            <Text className="approval-btn-text-deny">Deny</Text>
          </View>
        </View>
      )}
    </View>
  );
}

function BackToBottomBtn({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) return null;
  return (
    <View className="back-to-bottom" onClick={onClick}>
      <Text className="back-to-bottom-icon">v</Text>
    </View>
  );
}

export default function SpikeChatJson() {
  const [messages, setMessages] = useState<Message[]>(MOCK_MESSAGES);
  const [inputText, setInputText] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);

  const closeSettings = useCallback(() => {
    setSettingsClosing(true);
    setTimeout(() => {
      setShowSettings(false);
      setSettingsClosing(false);
    }, 250);
  }, []);
  const [permissionMode, setPermissionMode] = useState<"default" | "auto-accept" | "plan">("default");
  const [scrollTarget, setScrollTarget] = useState("");

  const scrollToBottom = useCallback(() => {
    setScrollTarget(`msg-${msgId}`);
    setTimeout(() => setScrollTarget(""), 500);
  }, []);

  // 消息数量变化后触发滚底
  useEffect(() => {
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      setScrollTarget(`msg-${lastMsg.id}`);
      setTimeout(() => setScrollTarget(""), 500);
    }
  }, [messages.length]);

  // 模拟流式输出
  const simulateStream = useCallback(() => {
    const fullText = "I've fixed the sequence number restoration. The client handler now reads the last acknowledged seq from the buffer store before assigning it to the connection state.";
    let i = 0;
    msgId++;
    const streamId = msgId;
    setMessages((prev) => [...prev, { id: streamId, type: "assistant", text: "", isPartial: true }]);
    setIsWorking(true);

    const timer = setInterval(() => {
      i += 2;
      if (i >= fullText.length) {
        clearInterval(timer);
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, text: fullText, isPartial: false } : m)),
        );
        setIsWorking(false);
        setStreamingText("");
      } else {
        const partial = fullText.slice(0, i);
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, text: partial } : m)),
        );
        setStreamingText(partial);
      }
      scrollToBottom();
    }, 30);
  }, [scrollToBottom]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isWorking) return;
    setInputText("");
    msgId++;
    setMessages((prev) => [...prev, { id: msgId, type: "user", text }]);
    setTimeout(scrollToBottom, 50);
    setTimeout(simulateStream, 800);
  }, [inputText, isWorking, scrollToBottom, simulateStream]);

  const handleToggleTime = useCallback((id: number) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, showTime: !m.showTime } : m)),
    );
  }, []);

  const handleToolToggle = useCallback((id: number) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, expanded: !m.expanded } : m)),
    );
  }, []);

  const handleApprove = useCallback((id: number, action: "allow" | "allowAll" | "deny") => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, approved: action === "deny" ? "deny" : "allow" } : m,
      ),
    );
  }, []);

  const handleScroll = useCallback((e) => {
    const { scrollTop, scrollHeight } = e.detail;
    const viewHeight = 600;
    const distFromBottom = scrollHeight - scrollTop - viewHeight;
    setShowBackToBottom(distFromBottom > 200);
  }, []);

  return (
    <View className="page">
      {/* Status line */}
      <View className={`status-line ${isWorking ? "working" : "idle"}`}>
        {isWorking && <View className="status-line-glow" />}
      </View>

      <ScrollView className="chat-scroll" scrollY scrollIntoView={scrollTarget}>
        {messages.map((msg) => (
          <View key={msg.id} id={`msg-${msg.id}`} className={`msg-row ${msg.type === "user" ? "user" : "assistant"}`}>
            {msg.type === "user" && (
              <View className="bubble-wrapper user" onClick={() => handleToggleTime(msg.id)}>
                <View className="bubble user anim-in-user">
                  <Text className="bubble-text-white">{msg.text}</Text>
                </View>
                {msg.showTime && <Text className="msg-time user">{msg.time}</Text>}
              </View>
            )}
            {msg.type === "assistant" && (
              <View className="bubble-wrapper assistant" onClick={() => handleToggleTime(msg.id)}>
                <View className="bubble assistant anim-in-assistant">
                  <Text className="bubble-text-dark">
                    {msg.text}
                    {msg.isPartial && <Text className="streaming-cursor">|</Text>}
                  </Text>
                </View>
                {msg.showTime && <Text className="msg-time assistant">{msg.time}</Text>}
              </View>
            )}
            {msg.type === "tool_call" && (
              <ToolCallCard msg={msg} onToggle={() => handleToolToggle(msg.id)} />
            )}
            {msg.type === "tool_approval" && (
              <ToolApprovalCard msg={msg} onApprove={(action) => handleApprove(msg.id, action)} />
            )}
          </View>
        ))}
      </ScrollView>

      <BackToBottomBtn visible={showBackToBottom} onClick={scrollToBottom} />

      {/* Input bar */}
      <View className="input-bar">
        <Input
          className="input-field"
          value={inputText}
          onInput={(e) => setInputText(e.detail.value)}
          onConfirm={handleSend}
          placeholder="Type a message..."
          confirmType="send"
          disabled={false}
        />
        <View className="menu-btn" onClick={() => showSettings ? closeSettings() : setShowSettings(true)}>
          <Text className="menu-btn-text">{"\u00B7\u00B7\u00B7"}</Text>
        </View>
        <View
          className={`send-btn ${inputText.trim() && !isWorking ? "active" : "disabled"}`}
          onClick={handleSend}
        >
          <Text className="send-btn-icon">{"\u2191"}</Text>
        </View>
      </View>

      {/* Settings panel */}
      {showSettings && (
        <View className={`settings-mask ${settingsClosing ? "closing" : ""}`} onClick={closeSettings}>
          <View className={`settings-panel ${settingsClosing ? "closing" : ""}`} onClick={(e) => e.stopPropagation()}>
            <Text className="settings-title">Settings</Text>

            <View className="settings-section">
              <Text className="settings-label">Permission Mode</Text>
              <View className="settings-options">
                {(["default", "auto-accept", "plan"] as const).map((m) => (
                  <View
                    key={m}
                    className={`settings-option ${permissionMode === m ? "active" : ""}`}
                    onClick={() => setPermissionMode(m)}
                  >
                    <Text className={`settings-option-text ${permissionMode === m ? "active" : ""}`}>
                      {m === "default" ? "Default" : m === "auto-accept" ? "Auto Accept" : "Plan"}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            <View className="settings-section">
              <Text className="settings-label">Font Size</Text>
              <View className="settings-font-row">
                <View className="font-icon-btn">
                  <Text className="font-icon-label">A</Text>
                  <Text className="font-icon-arrow">-</Text>
                </View>
                <View className="font-size-display">
                  <Text className="font-size-number">14</Text>
                </View>
                <View className="font-icon-btn">
                  <Text className="font-icon-label-lg">A</Text>
                  <Text className="font-icon-arrow">+</Text>
                </View>
              </View>
            </View>

          </View>
        </View>
      )}
    </View>
  );
}
