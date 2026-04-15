// Chat 页面：PTY 终端视图和 JSON 聊天气泡双模式，集成工具审批、picker、引用、设置菜单
import { useState, useCallback, useReducer, useEffect, useRef, useMemo } from "react";
import { View, Text } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { showToast, showErrorToast } from "@/components/toast";
import { showModal } from "@/components/modal";
import { SafeAreaHeader } from "@/components/safe-area-header";
import { TerminalViewport } from "@/components/terminal-viewport";
import { ChatBubbleList } from "@/components/chat-bubble-list";
import { InputBar, computeSendDisabled } from "@/components/input-bar";
import type { PickerMode, InputBarHandle } from "@/components/input-bar";
import { StatusLine } from "@/components/status-line";
import { BackToBottomButton } from "@/components/back-to-bottom";
import { ToolApprovalCard } from "@/components/tool-approval-card";
import { SlashCommandPicker } from "@/components/slash-command-picker";
import { FilePathPicker } from "@/components/file-path-picker";
import { QuotePreviewBar } from "@/components/quote-preview-bar";
import type { MessageEnvelope, RelayControlMessage, TerminalFramePayload } from "@cc-anywhere/shared";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import { parseAssistantMessage, routeStreamEvent, formatToolTitle } from "@/services/message-parser";
import { useScreenSize } from "@/hooks/use-screen-size";
import {
  chatReducer,
  initialChatState,
} from "@/stores/chat-store";
import type { ChatAction, QuotedMessage } from "@/stores/chat-store";
import {
  terminalReducer,
  initialTerminalState,
  FONT_SIZES,
} from "@/stores/terminal-store";
import { useCommandState, useCommandDispatch } from "@/stores/command-store";
import { useFileState, useFileDispatch } from "@/stores/file-store";
import { useRelayClient } from "@/stores/relay-store";
import { useAppState, useAppDispatch } from "@/stores/app-store";
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
  const relay = useRelayClient();
  const appState = useAppState();
  const appDispatch = useAppDispatch();

  // 发送前检查连接状态和 proxy 在线状态，未就绪时提示用户
  const checkConnected = useCallback((): boolean => {
    if (!appState.connected) {
      showToast("Not connected to relay server");
      return false;
    }
    if (!appState.proxyOnline) {
      showToast("Proxy is offline");
      return false;
    }
    return true;
  }, [appState.connected, appState.proxyOnline]);

  const [chatState, chatDispatch] = useReducer(chatReducer, initialChatState);
  const [terminalState, terminalDispatch] = useReducer(terminalReducer, initialTerminalState);
  const chatStateRef = useRef(chatState);
  chatStateRef.current = chatState;
  const terminalStateRef = useRef(terminalState);
  terminalStateRef.current = terminalState;

  // 根据 viewport 高度和字体大小计算可显示行数
  const getViewportRows = useCallback(() => {
    const el = document.querySelector(".terminal-viewport");
    const contentEl = document.querySelector(".terminal-content");
    if (!el || !contentEl) return 40;
    const h = el.getBoundingClientRect().height;
    const lineH = Math.round(terminalState.fontSize * 1.4);
    if (lineH <= 0) return 40;
    const style = getComputedStyle(contentEl);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return Math.floor((h - pad) / lineH) || 40;
  }, [terminalState.fontSize]);

  // 字体大小变化时持久化到 Storage
  useEffect(() => {
    Taro.setStorageSync("cc_fontSizeIndex", terminalState.fontSizeIndex);
  }, [terminalState.fontSizeIndex]);

  const commandState = useCommandState();
  const commandDispatch = useCommandDispatch();
  const fileState = useFileState();
  const fileDispatch = useFileDispatch();
  const inputBarRef = useRef<InputBarHandle>(null);

  // relay 消息订阅：路由 envelope 和 control 消息到对应的 store
  useEffect(() => {
    if (!relay || !sessionId) return;

    const unsub = relay.onMessage((msg) => {
      // MessageEnvelope 类型：有 seq/payload/sessionId 字段
      if ("seq" in msg && "payload" in msg) {
        const envelope = msg as MessageEnvelope;

        switch (envelope.type) {
          case "assistant_message": {
            const parsed = parseAssistantMessage(envelope.payload.text);
            if (parsed) {
              const action = routeStreamEvent(parsed);
              if (action) {
                chatDispatch(action as ChatAction);
              }
              if (parsed.type === "result") {
                relay.sendControl({ type: "session_resources_request", sessionId } as never);
              }
            }
            relay.updateSeq(envelope.sessionId, envelope.seq);
            break;
          }
          case "tool_use_request": {
            chatDispatch({
              type: "SET_WORKING_TOOL",
              toolName: formatToolTitle(
                envelope.payload.toolName,
                envelope.payload.parameters as Record<string, unknown> || {},
              ),
            });
            chatDispatch({
              type: "ADD_APPROVAL_REQUEST",
              request: {
                requestId: envelope.payload.toolId,
                toolName: envelope.payload.toolName,
                input: envelope.payload.parameters,
                status: "pending",
              },
            });
            relay.updateSeq(envelope.sessionId, envelope.seq);
            break;
          }
          case "tool_result": {
            const msgs = chatStateRef.current.messages;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant" && msgs[i].toolCalls.length > 0) {
                const idx = msgs[i].toolCalls.findIndex((tc) => !tc.output);
                if (idx >= 0) {
                  chatDispatch({
                    type: "UPDATE_TOOL_RESULT",
                    messageId: msgs[i].id,
                    toolIndex: idx,
                    output: String(envelope.payload.result),
                  });
                }
                break;
              }
            }
            relay.updateSeq(envelope.sessionId, envelope.seq);
            break;
          }
          case "session_status": {
            if (envelope.payload.sessionId === sessionId) {
              chatDispatch({
                type: "SET_WORKING",
                isWorking: envelope.payload.state === "working",
              });
            }
            break;
          }
          case "session_list": {
            if (sessionId && envelope.payload?.sessions) {
              const sessions = envelope.payload.sessions as Array<{ id?: string; sessionId?: string }>;
              const stillExists = sessions.some(s => (s.sessionId || s.id) === sessionId);
              if (!stillExists) {
                void showModal({
                  title: "Session Ended",
                  content: "The terminal session has exited.",
                  showCancel: false,
                  confirmText: "OK",
                }).then(() => {
                  const target = appState.proxyOnline
                    ? "/pages/session-list/index"
                    : "/pages/proxy-select/index";
                  Taro.reLaunch({ url: target });
                });
              }
            }
            break;
          }
          default:
            break;
        }
        return;
      }

      // RelayControlMessage 类型
      const ctrl = msg as RelayControlMessage;

      switch (ctrl.type) {
        case "terminal_frame": {
          if (ctrl.sessionId !== sessionId) break;
          const frame = ctrl.payload as TerminalFramePayload;
          if (frame.mode === "full") {
            const fullFrame = frame as TerminalFramePayload & { anchorLineId?: number; newestLineId?: number };
            if (fullFrame.anchorLineId != null) {
              terminalDispatch({ type: "CACHE_FRAME", anchorLineId: fullFrame.anchorLineId, lines: frame.lines });
              terminalDispatch({ type: "SET_SCROLL_STATE", anchorLineId: fullFrame.anchorLineId, newestLineId: fullFrame.newestLineId ?? null, lines: frame.lines });
            } else {
              // live 帧：仅在非锚定模式下更新
              terminalDispatch({ type: "SET_TERMINAL_LINES", lines: frame.lines });
              if (fullFrame.newestLineId != null) {
                terminalDispatch({ type: "SET_SCROLL_STATE", anchorLineId: null, newestLineId: fullFrame.newestLineId });
              }
            }
          } else {
            // delta 模式：仅在非锚定模式下合并
            if (terminalStateRef.current.anchorLineId === null) {
              const merged = [...terminalStateRef.current.lines];
              for (const delta of frame.lines) {
                merged[delta.lineIndex] = delta.spans;
              }
              terminalDispatch({ type: "SET_TERMINAL_LINES", lines: merged });
            }
          }
          break;
        }
        case "pty_state": {
          if (ctrl.sessionId !== sessionId) break;
          terminalDispatch({
            type: "SET_PTY_STATE",
            state: ctrl.payload.state,
            title: ctrl.payload.title,
          });
          if (ctrl.payload.state === "approval_wait" && ctrl.payload.tool) {
            terminalDispatch({ type: "SET_APPROVAL_TOOL", tool: ctrl.payload.tool });
          }
          break;
        }
        case "terminal_title": {
          if (ctrl.sessionId !== sessionId) break;
          terminalDispatch({ type: "SET_PTY_TITLE", title: (ctrl as unknown as { title: string }).title });
          break;
        }
        case "command_list_push": {
          const commands = (ctrl as unknown as { commands: Array<{ name: string; description: string; argumentHint?: string; source: string }> }).commands;
          commandDispatch({ type: "SET_COMMANDS", commands });
          break;
        }
        case "dir_list_response": {
          const { path, entries } = ctrl as unknown as { path: string; entries: Array<{ name: string; isDir: boolean }> };
          fileDispatch({ type: "SET_DIR_ENTRIES", path, entries });
          break;
        }
        case "file_tree_push": {
          const { path, entries } = ctrl as unknown as { path: string; entries: Array<{ name: string; isDir: boolean }> };
          fileDispatch({ type: "SET_DIR_ENTRIES", path, entries });
          projectRootRef.current = path;
          break;
        }
        case "session_history_messages": {
          if (ctrl.sessionId === sessionId) {
            setLoadingHistory(false);
            const hasHistory = chatStateRef.current.messages.some((m) => m.id.startsWith("history-"));
            if (ctrl.messages.length > 0 && !hasHistory) {
              chatDispatch({ type: "LOAD_HISTORY", messages: ctrl.messages });
            }
          }
          break;
        }
        case "pending_approvals_push": {
          if (ctrl.sessionId === sessionId) {
            const approvals = (ctrl as unknown as { approvals: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> }).approvals;
            for (const a of approvals) {
              chatDispatch({
                type: "ADD_APPROVAL_REQUEST",
                request: { requestId: a.requestId, toolName: a.toolName, input: a.input, status: "pending" },
              });
            }
            chatDispatch({ type: "SET_WORKING", isWorking: true });
          }
          break;
        }
        case "relay_error": {
          const err = ctrl as Record<string, unknown>;
          showErrorToast(`${err.message || err.code}`);
          break;
        }
        default:
          break;
      }
    });

    return unsub;
  }, [relay, sessionId, chatDispatch, terminalDispatch]);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [historyShown, setHistoryShown] = useState(30);
  const [pickerMode, setPickerMode] = useState<PickerMode>("none");
  const [filterText, setFilterText] = useState("");
  const [filePickerPath, setFilePickerPath] = useState("/");
  const projectRootRef = useRef("/");
  const [argumentHint, setArgumentHint] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [permissionMode, setPermissionMode] = useState<"default" | "auto_accept" | "plan">("default");
  const [loadingHistory, setLoadingHistory] = useState(false);

  const isPty = mode === "pty";
  const isDark = true;

  // 挂载时确保 client 绑定到正确的 proxy，然后请求终端帧
  useEffect(() => {
    if (!relay || !sessionId) return;
    let cancelled = false;

    async function bind() {
      if (!relay) return;
      const result = await ensureBinding(relay, {
        proxyId: appState.selectedProxyId || undefined,
        sessionId,
      });
      if (cancelled) return;
      if (isBindingError(result)) {
        showErrorToast(`Binding failed: ${result.error}`);
        return;
      }
      // 绑定成功，更新 proxy 状态
      appDispatch({ type: "SET_PROXY", proxyId: result.proxyId, proxyName: null });
      appDispatch({ type: "SET_PROXY_ONLINE", online: true });
      if (isPty) {
        relay.sendControl({ type: "terminal_frame_request", sessionId, rows: getViewportRows() });
      } else {
        setLoadingHistory(true);
        relay.sendControl({ type: "session_messages_request", sessionId } as never);
        relay.sendControl({ type: "session_resources_request", sessionId } as never);
      }
    }

    // 已绑定时直接请求帧/历史，否则走绑定流程
    const boundId = relay.getBoundProxyId();
    if (boundId) {
      appDispatch({ type: "SET_PROXY_ONLINE", online: true });
      if (isPty) {
        relay.sendControl({ type: "terminal_frame_request", sessionId, rows: getViewportRows() });
      } else {
        setLoadingHistory(true);
        relay.sendControl({ type: "session_messages_request", sessionId } as never);
        relay.sendControl({ type: "session_resources_request", sessionId } as never);
      }
    } else {
      bind();
    }

    return () => { cancelled = true; };
  }, [relay, sessionId, isPty, appState.selectedProxyId]);

  const sendDisabled = computeSendDisabled(
    mode,
    chatState.isWorking,
    chatState.pendingApprovals,
  );

  const statusState = !appState.connected || !appState.proxyOnline
    ? "disconnected" as const
    : statusFromState(
        mode,
        terminalState.ptyState,
        chatState.isWorking,
        chatState.pendingApprovals,
      );

  const pendingApprovals = chatState.pendingApprovals.filter((a) => a.status === "pending");

  const handleSend = useCallback(
    (text: string, quote?: QuotedMessage) => {
      chatDispatch({
        type: "ADD_USER_MESSAGE",
        message: {
          id: `user-${Date.now()}`,
          role: "user",
          text,
          isPartial: false,
          timestamp: Date.now(),
          toolCalls: [],
          quotedMessage: quote,
        },
      });
      chatDispatch({ type: "SET_WORKING", isWorking: true });
      chatDispatch({ type: "CLEAR_QUOTE" });
      setArgumentHint("");
      if (relay && sessionId && checkConnected()) {
        relay.sendEnvelope({
          type: "user_input",
          sessionId,
          payload: { text },
          seq: 0,
          timestamp: Date.now(),
          source: "client",
          version: "1",
        } as MessageEnvelope);
      }
    },
    [chatDispatch, relay, sessionId, checkConnected],
  );

  const handleScrollThreshold = useCallback((nearBottom: boolean) => {
    setIsNearBottom(nearBottom);
  }, []);

  const handleBackToBottom = useCallback(() => {
    setIsNearBottom(true);
  }, []);

  const handleTerminalScroll = useCallback(
    (direction: "up" | "down", delta: number) => {
      if (!relay || !sessionId) return;

      const state = terminalStateRef.current;
      const rows = getViewportRows();

      if (state.anchorLineId != null) {
        const targetAnchor = direction === "up"
          ? state.anchorLineId - delta
          : state.anchorLineId + delta;

        // scrollDown 回到 live 模式
        if (direction === "down" && state.newestLineId != null && targetAnchor + rows > state.newestLineId) {
          terminalDispatch({ type: "CLEAR_ANCHOR" });
          relay.sendControl({ type: "terminal_frame_request", sessionId, rows: getViewportRows() });
          return;
        }

        // 命中缓存则直接显示
        const cached = state.frameCache.get(targetAnchor);
        if (cached) {
          terminalDispatch({ type: "SET_SCROLL_STATE", anchorLineId: targetAnchor, newestLineId: state.newestLineId, lines: cached });
        }
      }

      // 始终发送到服务端以同步锚点状态，带上客户端 viewport 行数
      relay.sendControl({
        type: "terminal_scroll_request",
        sessionId,
        direction,
        delta,
        rows,
      });
    },
    [relay, sessionId, terminalDispatch, getViewportRows],
  );

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
      chatDispatch({ type: "SET_WORKING", isWorking: true });
      if (relay && sessionId && checkConnected()) {
        relay.sendEnvelope({
          type: "tool_approve",
          sessionId,
          payload: { toolId: requestId },
          seq: 0,
          timestamp: Date.now(),
          source: "client",
          version: "1",
        } as MessageEnvelope);
      }
    },
    [chatDispatch, relay, sessionId, checkConnected],
  );

  const handleToolAllowAll = useCallback(
    (requestId: string) => {
      chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId, status: "approved" });
      chatDispatch({ type: "SET_WORKING", isWorking: true });
      if (relay && sessionId && checkConnected()) {
        relay.sendEnvelope({
          type: "tool_approve",
          sessionId,
          payload: { toolId: requestId, whitelistTool: true },
          seq: 0,
          timestamp: Date.now(),
          source: "client",
          version: "1",
        } as MessageEnvelope);
      }
    },
    [chatDispatch, relay, sessionId, checkConnected],
  );

  const handleToolDeny = useCallback(
    (requestId: string) => {
      chatDispatch({ type: "UPDATE_APPROVAL_STATUS", requestId, status: "denied" });
      if (relay && sessionId && checkConnected()) {
        relay.sendEnvelope({
          type: "tool_deny",
          sessionId,
          payload: { toolId: requestId },
          seq: 0,
          timestamp: Date.now(),
          source: "client",
          version: "1",
        } as MessageEnvelope);
      }
    },
    [chatDispatch, relay, sessionId, checkConnected],
  );

  const handleToggleToolCollapse = useCallback(
    (messageId: string, toolIndex: number) => {
      chatDispatch({ type: "TOGGLE_TOOL_COLLAPSE", messageId, toolIndex });
    },
    [chatDispatch],
  );

  // Picker 相关
  const handlePickerModeChange = useCallback((newMode: PickerMode) => {
    setPickerMode(newMode);
    if (newMode === "file") {
      setFilePickerPath(projectRootRef.current);
    }
  }, []);

  const handleFilterChange = useCallback((text: string) => {
    setFilterText(text);
  }, []);

  const handleSelectCommand = useCallback(
    (cmd: { name: string; argumentHint?: string }) => {
      setPickerMode("none");
      setArgumentHint(cmd.argumentHint || "");
      inputBarRef.current?.replaceCommand(cmd.name, cmd.argumentHint);
      inputBarRef.current?.focus();
    },
    [],
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      setPickerMode("none");
      inputBarRef.current?.insertFileRef(path);
      inputBarRef.current?.focus();
    },
    [],
  );

  const handleFileNavigate = useCallback(
    (path: string) => {
      setFilePickerPath(path);
      if (!fileState.tree.has(path) && relay && checkConnected()) {
        relay.sendControl({ type: "dir_list_request", path });
      }
    },
    [fileState.tree, relay, checkConnected],
  );

  // 引用
  const handleQuote = useCallback(
    (quote: QuotedMessage) => {
      chatDispatch({ type: "SET_QUOTE", quote });
    },
    [chatDispatch],
  );

  const handleCancelQuote = useCallback(() => {
    chatDispatch({ type: "CLEAR_QUOTE" });
  }, [chatDispatch]);

  // 设置菜单
  const handleMenuPress = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  const handlePermissionChange = useCallback(
    (newMode: "default" | "auto_accept" | "plan") => {
      setPermissionMode(newMode);
      if (relay && checkConnected()) {
        relay.sendControl({ type: "permission_mode_change", mode: newMode });
      }
    },
    [relay, checkConnected],
  );

  const handleFontSizeChange = useCallback(
    (direction: "increase" | "decrease") => {
      const newIdx =
        direction === "increase"
          ? Math.min(terminalState.fontSizeIndex + 1, FONT_SIZES.length - 1)
          : Math.max(terminalState.fontSizeIndex - 1, 0);
      terminalDispatch({ type: "SET_FONT_SIZE_INDEX", index: newIdx });
    },
    [terminalState.fontSizeIndex, terminalDispatch],
  );

  const handleWindowToggle = useCallback(() => {
    if (screen.windowWidth >= 860) {
      Taro.getApp().tt?.setWindowSize?.({ width: 350, height: 600 });
    } else {
      Taro.getApp().tt?.setWindowSize?.({ width: 900, height: 700 });
    }
  }, [screen.windowWidth]);

  const handleTapToReturn = useCallback(() => {
    terminalDispatch({ type: "CLEAR_ANCHOR" });
    if (relay && sessionId) {
      relay.sendControl({ type: "terminal_frame_request", sessionId, rows: getViewportRows() });
    }
  }, [relay, sessionId, terminalDispatch]);

  // 历史消息分页渲染：只显示最后 historyShown 条历史 + 全部实时消息
  const historyCount = useMemo(
    () => chatState.messages.filter((m) => m.id.startsWith("history-")).length,
    [chatState.messages],
  );
  const visibleMessages = useMemo(() => {
    const skip = Math.max(0, historyCount - historyShown);
    return skip > 0 ? chatState.messages.slice(skip) : chatState.messages;
  }, [chatState.messages, historyCount, historyShown]);

  const handleLoadMoreHistory = useCallback(() => {
    setHistoryShown((prev) => prev + 30);
  }, []);

  return (
    <View className={`chat-page ${isDark ? "chat-page-dark" : ""} ${screen.className}`}>
      <SafeAreaHeader
        title={
          isPty
            ? (terminalState.ptyTitle || (router.params.name ? decodeURIComponent(router.params.name) : null) || "Chat")
            : (chatState.isWorking
              ? (chatState.workingToolName || "Thinking...")
              : (router.params.name ? decodeURIComponent(router.params.name) : null) || "Chat")
        }
        statusBarHeight={screen.statusBarHeight}
        transparent={isDark}
        onBack={() => {
          Taro.removeStorageSync("cc_sessionId");
          Taro.removeStorageSync("cc_sessionMode");
          Taro.navigateBack();
        }}
      />
      <View className="chat-page-body" style={{ paddingTop: `${screen.statusBarHeight + 88}px` }}>
        <StatusLine state={statusState} />
        <View className="chat-content">
          {isPty ? (
            <TerminalViewport
              lines={terminalState.lines}
              fontSize={terminalState.fontSize}
              onPinchZoom={handlePinchZoom}
              onScroll={handleTerminalScroll}
              isScrolled={terminalState.anchorLineId !== null}
              onTapToReturn={handleTapToReturn}
            />
          ) : (
            <>
              <ChatBubbleList
                messages={visibleMessages}
                hasMoreHistory={historyCount > historyShown}
                onLoadMore={handleLoadMoreHistory}
                isWorking={chatState.isWorking}
                onScrollThresholdChange={handleScrollThreshold}
                onToggleToolCollapse={handleToggleToolCollapse}
                onQuote={handleQuote}
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

        {/* Picker panels above input bar */}
        <SlashCommandPicker
          commands={commandState.commands}
          filter={filterText}
          onSelect={handleSelectCommand}
          visible={pickerMode === "slash"}
        />
        <FilePathPicker
          tree={fileState.tree}
          currentPath={filePickerPath}
          filter={filterText}
          onSelect={handleSelectFile}
          onNavigate={handleFileNavigate}
          visible={pickerMode === "file"}
        />

        {/* Quote preview bar */}
        {chatState.quotedMessage && (
          <QuotePreviewBar
            quote={chatState.quotedMessage}
            onCancel={handleCancelQuote}
          />
        )}

        <View className="input-bar-wrapper">
          <InputBar
            ref={inputBarRef}
            onSend={handleSend}
            disabled={sendDisabled.disabled}
            disabledReason={sendDisabled.reason}
            mode={mode}
            onMenuPress={handleMenuPress}
            onPickerModeChange={handlePickerModeChange}
            onFilterChange={handleFilterChange}
            quotedMessage={chatState.quotedMessage}
            onCancelQuote={handleCancelQuote}
            argumentHint={argumentHint}
          />
        </View>
      </View>

      {!isPty && (
        <BackToBottomButton visible={!isNearBottom} onClick={handleBackToBottom} />
      )}

      {loadingHistory && (
        <View className="chat-loading-overlay">
          <View className="chat-loading-ring">
            <View className="chat-loading-dot" />
            <View className="chat-loading-dot" />
            <View className="chat-loading-dot" />
            <View className="chat-loading-dot" />
            <View className="chat-loading-dot" />
          </View>
          <Text className="chat-loading-text">Loading history...</Text>
        </View>
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

      {/* Settings menu overlay */}
      {showSettings && (
        <View className="settings-overlay" onClick={handleCloseSettings}>
          <View
            className="settings-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <View className="settings-header">
              <Text className="settings-title">Settings</Text>
            </View>

            {/* Permission mode */}
            <View className="settings-section">
              <Text className="settings-section-label">Permission Mode</Text>
              <View className="settings-chips">
                {(["default", "auto_accept", "plan"] as const).map((m) => (
                  <View
                    key={m}
                    className={`settings-chip ${permissionMode === m ? "active" : ""}`}
                    onClick={() => handlePermissionChange(m)}
                  >
                    <Text className={`settings-chip-text ${permissionMode === m ? "active" : ""}`}>
                      {m === "default" ? "Default" : m === "auto_accept" ? "Auto Accept" : "Plan"}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Font size */}
            <View className="settings-section">
              <Text className="settings-section-label">Font Size</Text>
              <View className="settings-font-controls">
                <View
                  className="settings-font-btn"
                  onClick={() => handleFontSizeChange("decrease")}
                >
                  <Text className="settings-font-btn-text">A-</Text>
                </View>
                <Text className="settings-font-size-display">
                  {FONT_SIZES[terminalState.fontSizeIndex]}px
                </Text>
                <View
                  className="settings-font-btn"
                  onClick={() => handleFontSizeChange("increase")}
                >
                  <Text className="settings-font-btn-text">A+</Text>
                </View>
              </View>
            </View>

            {/* PC window toggle -- only visible on PC */}
            {screen.deviceType === "pc" && (
              <View className="settings-section">
                <View className="settings-window-btn" onClick={handleWindowToggle}>
                  <Text className="settings-window-btn-text">
                    {screen.windowWidth >= 860 ? "Shrink Window" : "Expand Window"}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
