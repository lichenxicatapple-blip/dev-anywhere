// 聊天页面：双模式渲染（PTY 终端 + JSON 气泡），自定义导航，消息收发
import { useEffect, useCallback, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useScreenSize } from "@/hooks/use-screen-size";
import { useSessionState, useSessionDispatch } from "@/stores/session-store";
import { useTerminalState, useTerminalDispatch } from "@/stores/terminal-store";
import { useChatState, useChatDispatch } from "@/stores/chat-store";
import { SafeAreaHeader } from "@/components/safe-area-header";
import { StatusLine } from "@/components/status-line";
import { TerminalViewport } from "@/components/terminal-viewport";
import { ChatBubbleList } from "@/components/chat-bubble-list";
import { InputBar, computeSendDisabled } from "@/components/input-bar";
import type { MessageEnvelope, RelayControlMessage } from "@cc-anywhere/shared";
import "./index.css";

// PTY 状态映射到 StatusLine 接受的状态
function mapPtyState(ptyState: string): "idle" | "working" | "waiting_approval" | "terminated" {
  switch (ptyState) {
    case "working":
      return "working";
    case "approval_wait":
      return "waiting_approval";
    case "turn_complete":
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

// 根据会话信息生成标题
function generateSessionTitle(sessionId: string | null, mode: "pty" | "json" | null): string {
  if (!sessionId) return "Chat";
  const shortId = sessionId.slice(0, 8);
  if (mode === "pty") return `Terminal ${shortId}`;
  return `Chat ${shortId}`;
}

export default function ChatPage() {
  const router = useRouter();
  const screenInfo = useScreenSize();
  const sessionState = useSessionState();
  const sessionDispatch = useSessionDispatch();
  const terminalState = useTerminalState();
  const terminalDispatch = useTerminalDispatch();
  const chatState = useChatState();
  const chatDispatch = useChatDispatch();
  const [isNearBottom, setIsNearBottom] = useState(true);

  const sessionId = router.params.sessionId || sessionState.currentSessionId;
  const mode = sessionState.currentSessionMode || "pty";

  // 页面挂载时设置当前会话
  useEffect(() => {
    const paramSessionId = router.params.sessionId;
    const paramMode = (router.params.mode as "pty" | "json") || null;
    if (paramSessionId) {
      sessionDispatch({
        type: "SET_CURRENT_SESSION",
        sessionId: paramSessionId,
        mode: paramMode || sessionState.currentSessionMode,
      });
    }
  }, [router.params.sessionId, router.params.mode]);

  // 处理 relay 消息
  const handleRelayMessage = useCallback(
    (msg: MessageEnvelope | RelayControlMessage) => {
      if ("type" in msg) {
        switch (msg.type) {
          case "terminal_frame":
            if ("payload" in msg && msg.payload) {
              const payload = msg.payload as { mode: string; lines?: unknown[][] };
              if (payload.mode === "full" && Array.isArray(payload.lines)) {
                terminalDispatch({ type: "SET_TERMINAL_LINES", lines: payload.lines as import("@cc-anywhere/shared").TermLine[] });
              }
            }
            break;
          case "pty_state":
            if ("payload" in msg && msg.payload) {
              const payload = msg.payload as { state: string; title?: string };
              terminalDispatch({
                type: "SET_PTY_STATE",
                state: payload.state as "working" | "turn_complete" | "approval_wait" | "idle",
                title: payload.title,
              });
            }
            break;
          case "assistant_message":
            if ("payload" in msg) {
              const payload = msg.payload as { text?: string };
              if (payload.text) {
                chatDispatch({ type: "APPEND_ASSISTANT_TEXT", text: payload.text });
              }
            }
            break;
          case "tool_use_request":
            if ("payload" in msg) {
              const payload = msg.payload as { requestId: string; toolName: string; input: Record<string, unknown> };
              chatDispatch({
                type: "ADD_APPROVAL_REQUEST",
                request: {
                  requestId: payload.requestId || `req-${Date.now()}`,
                  toolName: payload.toolName || "unknown",
                  input: payload.input || {},
                  status: "pending",
                },
              });
            }
            break;
          case "tool_result":
            if ("payload" in msg) {
              const payload = msg.payload as { toolName?: string; output?: string };
              const lastAssistant = chatState.messages.findLast((m) => m.role === "assistant");
              if (lastAssistant && payload.toolName) {
                chatDispatch({
                  type: "UPDATE_TOOL_RESULT",
                  messageId: lastAssistant.id,
                  toolName: payload.toolName,
                  output: payload.output || "",
                });
              }
            }
            break;
          case "session_status":
            if ("payload" in msg) {
              const payload = msg.payload as { state?: string };
              const isWorking = payload.state === "working";
              chatDispatch({ type: "SET_WORKING", isWorking });
              if (!isWorking) {
                chatDispatch({ type: "MARK_TURN_COMPLETE" });
              }
            }
            break;
        }
      }
    },
    [terminalDispatch, chatDispatch, chatState.messages],
  );

  // 保留 handleRelayMessage 引用供将来接入 relay 订阅
  void handleRelayMessage;

  // 发送消息
  const handleSend = useCallback(
    (text: string) => {
      if (mode === "json") {
        // 乐观添加到本地消息列表
        chatDispatch({
          type: "ADD_USER_MESSAGE",
          message: {
            id: `user-${Date.now()}`,
            role: "user",
            text,
            isPartial: false,
            timestamp: Date.now(),
            toolCalls: [],
          },
        });
      }
      // 构建 user_input 信封发送
      // relay 客户端发送将在集成时接入
      console.log(`[ChatPage] send ${mode} message:`, text);
    },
    [mode, chatDispatch],
  );

  // 终端捏合缩放
  const handlePinchZoom = useCallback(
    (direction: "in" | "out") => {
      const newIndex =
        direction === "in"
          ? Math.min(terminalState.fontSizeIndex + 1, 5)
          : Math.max(terminalState.fontSizeIndex - 1, 0);
      terminalDispatch({ type: "SET_FONT_SIZE_INDEX", index: newIndex });
    },
    [terminalState.fontSizeIndex, terminalDispatch],
  );

  const handleScrollThresholdChange = useCallback((nearBottom: boolean) => {
    setIsNearBottom(nearBottom);
  }, []);

  void isNearBottom;

  // 菜单按钮，Plan 09/11 接入设置面板
  const handleMenuPress = useCallback(() => {
    console.log("[ChatPage] menu pressed, settings panel deferred to Plan 09");
  }, []);

  // 计算 send 按钮禁用状态
  const sendState = computeSendDisabled(
    mode,
    chatState.isWorking,
    chatState.pendingApprovals,
  );

  // 状态栏映射
  const statusLineState =
    mode === "pty"
      ? mapPtyState(terminalState.ptyState)
      : chatState.isWorking
        ? "working"
        : chatState.pendingApprovals.some((a) => a.status === "pending")
          ? "waiting_approval"
          : "idle";

  const title = terminalState.ptyTitle || generateSessionTitle(sessionId, mode);
  const headerTopPadding = screenInfo.statusBarHeight + 44;

  return (
    <View className={`chat-page ${screenInfo.className} ${mode === "pty" ? "chat-page-dark" : ""}`}>
      <SafeAreaHeader
        title={title}
        statusBarHeight={screenInfo.statusBarHeight}
        transparent={mode === "pty"}
        onBack={() => Taro.navigateBack()}
      />

      <View className="chat-page-body" style={{ paddingTop: `${headerTopPadding}px` }}>
        <StatusLine state={statusLineState} />

        {mode === "pty" ? (
          <TerminalViewport
            lines={terminalState.lines}
            fontSize={terminalState.fontSize}
            onPinchZoom={handlePinchZoom}
          />
        ) : (
          <View className="chat-content">
            <ChatBubbleList
              messages={chatState.messages}
              isWorking={chatState.isWorking}
              onScrollThresholdChange={handleScrollThresholdChange}
            />
          </View>
        )}

        <View className="input-bar-wrapper">
          <InputBar
            onSend={handleSend}
            disabled={sendState.disabled}
            disabledReason={sendState.reason}
            mode={mode}
            onMenuPress={handleMenuPress}
          />
        </View>
      </View>
    </View>
  );
}
