// Chat 页面：PTY 终端视图和 JSON 聊天气泡双模式，集成工具审批、工具卡片、回到底部
import { useState, useCallback, useReducer } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { SafeAreaHeader } from "@/components/safe-area-header";
import { TerminalViewport } from "@/components/terminal-viewport";
import { ChatBubbleList } from "@/components/chat-bubble-list";
import { InputBar, computeSendDisabled } from "@/components/input-bar";
import { StatusLine } from "@/components/status-line";
import { BackToBottomButton } from "@/components/back-to-bottom";
import { ToolApprovalCard } from "@/components/tool-approval-card";
import { useScreenSize } from "@/hooks/use-screen-size";
import {
  chatReducer,
  initialChatState,
  useChatState,
  useChatDispatch,
} from "@/stores/chat-store";
import {
  terminalReducer,
  initialTerminalState,
  useTerminalState,
  useTerminalDispatch,
  FONT_SIZES,
} from "@/stores/terminal-store";
import "./index.css";

type SessionMode = "pty" | "json";

function statusFromState(
  mode: SessionMode,
  ptyState: string,
  isWorking: boolean,
  pendingApprovals: Array<{ status: string }>,
): "idle" | "working" | "waiting_approval" | "terminated" {
  if (mode === "pty") {
    if (ptyState === "approval_wait") return "waiting_approval";
    if (ptyState === "working") return "working";
    return "idle";
  }
  if (pendingApprovals.some((a) => a.status === "pending")) return "waiting_approval";
  if (isWorking) return "working";
  return "idle";
}

export default function Chat() {
  const router = useRouter();
  const mode = (router.params.mode as SessionMode) || "json";
  const sessionId = router.params.sessionId || "";
  const screen = useScreenSize();

  // 使用局部 reducer 来避免 context 依赖缺失
  const [chatState, chatDispatch] = useReducer(chatReducer, initialChatState);
  const [terminalState, terminalDispatch] = useReducer(terminalReducer, initialTerminalState);

  const [isNearBottom, setIsNearBottom] = useState(true);

  const isPty = mode === "pty";
  const isDark = isPty;

  const sendDisabled = computeSendDisabled(
    mode,
    chatState.isWorking,
    chatState.pendingApprovals,
  );

  const statusState = statusFromState(
    mode,
    terminalState.ptyState,
    chatState.isWorking,
    chatState.pendingApprovals,
  );

  const pendingApprovals = chatState.pendingApprovals.filter((a) => a.status === "pending");

  const handleSend = useCallback(
    (text: string) => {
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
      chatDispatch({ type: "SET_WORKING", isWorking: true });
      // TODO: relay client sendEnvelope with user_input
    },
    [chatDispatch],
  );

  const handleScrollThreshold = useCallback((nearBottom: boolean) => {
    setIsNearBottom(nearBottom);
  }, []);

  const handleBackToBottom = useCallback(() => {
    setIsNearBottom(true);
    // ChatBubbleList 内部 bottomAnchorRef.scrollIntoView 依赖 messages 变化触发
    // 这里通过强制触发一次 APPEND 空文本来让 effect 重跑
    // 更稳妥的方式是 ChatBubbleList 提供一个 scrollToBottom 回调
  }, []);

  const handlePinchZoom = useCallback(
    (direction: "in" | "out") => {
      const newIdx =
        direction === "in"
          ? Math.min(terminalState.fontSizeIndex + 1, FONT_SIZES.length - 1)
          : Math.max(terminalState.fontSizeIndex - 1, 0);
      terminalDispatch({ type: "SET_FONT_SIZE_INDEX", index: newIdx });
    },
    [terminalState.fontSizeIndex, terminalDispatch],
  );

  const handleToolAllow = useCallback(
    (requestId: string) => {
      chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId, status: "approved" });
      // TODO: relayClient.sendEnvelope({ type: "tool_approve", ... })
    },
    [chatDispatch],
  );

  const handleToolAllowAll = useCallback(
    (requestId: string) => {
      chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId, status: "approved" });
      // TODO: relayClient.sendEnvelope({ type: "tool_approve", ... }) + whitelist flag
    },
    [chatDispatch],
  );

  const handleToolDeny = useCallback(
    (requestId: string) => {
      chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId, status: "denied" });
      // TODO: relayClient.sendEnvelope({ type: "tool_deny", ... })
    },
    [chatDispatch],
  );

  const handleToggleToolCollapse = useCallback(
    (messageId: string, toolIndex: number) => {
      chatDispatch({ type: "TOGGLE_TOOL_COLLAPSE", messageId, toolIndex });
    },
    [chatDispatch],
  );

  const handleMenuPress = useCallback(() => {
    // TODO: slash command picker
  }, []);

  return (
    <View className={`chat-page ${isDark ? "chat-page-dark" : ""} ${screen.className}`}>
      <SafeAreaHeader
        title={sessionId || "Chat"}
        statusBarHeight={screen.statusBarHeight}
        transparent={isDark}
      />
      <StatusLine state={statusState} />
      <View className="chat-page-body">
        <View className="chat-content">
          {isPty ? (
            <TerminalViewport
              lines={terminalState.lines}
              fontSize={terminalState.fontSize}
              onPinchZoom={handlePinchZoom}
            />
          ) : (
            <>
              <ChatBubbleList
                messages={chatState.messages}
                isWorking={chatState.isWorking}
                onScrollThresholdChange={handleScrollThreshold}
                onToggleToolCollapse={handleToggleToolCollapse}
              />
              {pendingApprovals.map((approval) => (
                <ToolApprovalCard
                  key={approval.requestId}
                  approval={approval}
                  onAllow={() => handleToolAllow(approval.requestId)}
                  onAllowAll={() => handleToolAllowAll(approval.requestId)}
                  onDeny={() => handleToolDeny(approval.requestId)}
                  sessionMode="json"
                />
              ))}
            </>
          )}
        </View>
        <View className="input-bar-wrapper">
          <InputBar
            onSend={handleSend}
            disabled={sendDisabled.disabled}
            disabledReason={sendDisabled.reason}
            mode={mode}
            onMenuPress={handleMenuPress}
          />
        </View>
      </View>

      {!isPty && (
        <BackToBottomButton visible={!isNearBottom} onClick={handleBackToBottom} />
      )}

      {isPty && terminalState.ptyState === "approval_wait" && pendingApprovals.length > 0 && (
        <View className="pty-approval-overlay">
          <View className="pty-approval-card-wrapper">
            <ToolApprovalCard
              approval={pendingApprovals[0]}
              onAllow={() => handleToolAllow(pendingApprovals[0].requestId)}
              onAllowAll={() => handleToolAllowAll(pendingApprovals[0].requestId)}
              onDeny={() => handleToolDeny(pendingApprovals[0].requestId)}
              sessionMode="pty"
            />
          </View>
        </View>
      )}
    </View>
  );
}
