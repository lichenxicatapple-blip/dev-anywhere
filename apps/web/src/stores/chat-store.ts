// 聊天状态管理: 按 sessionId 切片, 每个 slice 含消息/审批/引用/输入草稿/历史游标
import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface ToolCallInfo {
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  collapsed: boolean;
}

export interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
}

export interface QuotedMessage {
  from: "assistant" | "user";
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  isPartial: boolean;
  timestamp: number;
  toolCalls: ToolCallInfo[];
  quotedMessage?: QuotedMessage;
}

interface ChatSessionSlice {
  messages: ChatMessage[];
  // workingToolName 保留：session.state 只到 working 粒度，承载不了具体工具名
  workingToolName: string;
  pendingApprovals: ToolApprovalRequest[];
  quotedMessage: QuotedMessage | null;
  inputDraft: string;
  // 游标范围 [-1, historyLen - 1]; -1 表示未激活历史回溯
  inputHistoryCursor: number;
}

export const EMPTY_SLICE: ChatSessionSlice = {
  messages: [],
  workingToolName: "",
  pendingApprovals: [],
  quotedMessage: null,
  inputDraft: "",
  inputHistoryCursor: -1,
};

interface ChatStoreState {
  bySessionId: Record<string, ChatSessionSlice>;

  appendAssistantText: (sessionId: string, text: string) => void;
  addUserMessage: (sessionId: string, message: ChatMessage) => void;
  markTurnComplete: (sessionId: string) => void;
  addToolCall: (sessionId: string, messageId: string, toolCall: ToolCallInfo) => void;
  updateToolResult: (
    sessionId: string,
    messageId: string,
    toolIndex: number,
    output: string,
  ) => void;
  toggleToolCollapse: (sessionId: string, messageId: string, toolIndex: number) => void;
  addApprovalRequest: (sessionId: string, request: ToolApprovalRequest) => void;
  updateApprovalStatus: (
    sessionId: string,
    requestId: string,
    status: "approved" | "denied",
  ) => void;
  setWorkingTool: (sessionId: string, toolName: string) => void;
  setQuotedMessage: (sessionId: string, quote: QuotedMessage | null) => void;
  setInputDraft: (sessionId: string, draft: string) => void;
  // delta > 0 向更早的历史, delta < 0 向更新; clamp 在 [-1, historyLen - 1]
  // 历史游标由 InputBar 的 localStorage historyRef 决定长度, 直接 set 绝对值,
  // 避免原 moveInputHistoryCursor 用 slice.messages 长度 clamp 导致 PTY 模式失效
  setInputHistoryCursor: (sessionId: string, cursor: number) => void;
  resetInputHistoryCursor: (sessionId: string) => void;
  loadHistory: (
    sessionId: string,
    messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>,
  ) => void;
  clearSession: (sessionId: string) => void;
  clearAllSessions: () => void;
}

// 读取 slice 并应用 updater, 返回新的 bySessionId 增量
function updateSlice(
  state: ChatStoreState,
  sessionId: string,
  updater: (slice: ChatSessionSlice) => ChatSessionSlice,
): Partial<ChatStoreState> {
  const current = state.bySessionId[sessionId] ?? EMPTY_SLICE;
  const next = updater(current);
  return { bySessionId: { ...state.bySessionId, [sessionId]: next } };
}

export const useChatStore = create<ChatStoreState>()(
  devtools(
    (set) => ({
      bySessionId: {},

      appendAssistantText: (sessionId, text) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const last = slice.messages[slice.messages.length - 1];
            if (last && last.role === "assistant" && last.isPartial) {
              const updated = { ...last, text: last.text + text };
              return { ...slice, messages: [...slice.messages.slice(0, -1), updated] };
            }
            const newMsg: ChatMessage = {
              id: `${sessionId}-assistant-${Date.now()}`,
              role: "assistant",
              text,
              isPartial: true,
              timestamp: Date.now(),
              toolCalls: [],
            };
            return { ...slice, messages: [...slice.messages, newMsg] };
          }),
        ),

      addUserMessage: (sessionId, message) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: [...slice.messages, message],
          })),
        ),

      markTurnComplete: (sessionId) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: slice.messages.map((m) =>
              m.role === "assistant" && m.isPartial ? { ...m, isPartial: false } : m,
            ),
            workingToolName: "",
            pendingApprovals: [],
          })),
        ),

      addToolCall: (sessionId, messageId, toolCall) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: slice.messages.map((m) =>
              m.id === messageId ? { ...m, toolCalls: [...m.toolCalls, toolCall] } : m,
            ),
          })),
        ),

      updateToolResult: (sessionId, messageId, toolIndex, output) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: slice.messages.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc, i) =>
                      i === toolIndex ? { ...tc, output } : tc,
                    ),
                  }
                : m,
            ),
          })),
        ),

      toggleToolCollapse: (sessionId, messageId, toolIndex) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: slice.messages.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc, i) =>
                      i === toolIndex ? { ...tc, collapsed: !tc.collapsed } : tc,
                    ),
                  }
                : m,
            ),
          })),
        ),

      addApprovalRequest: (sessionId, request) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            pendingApprovals: [...slice.pendingApprovals, request],
          })),
        ),

      updateApprovalStatus: (sessionId, requestId, status) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            pendingApprovals: slice.pendingApprovals.map((a) =>
              a.requestId === requestId ? { ...a, status } : a,
            ),
          })),
        ),

      setWorkingTool: (sessionId, toolName) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({ ...slice, workingToolName: toolName })),
        ),

      setQuotedMessage: (sessionId, quote) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({ ...slice, quotedMessage: quote })),
        ),

      setInputDraft: (sessionId, draft) =>
        set((state) => updateSlice(state, sessionId, (slice) => ({ ...slice, inputDraft: draft }))),

      setInputHistoryCursor: (sessionId, cursor) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            inputHistoryCursor: cursor,
          })),
        ),

      resetInputHistoryCursor: (sessionId) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({ ...slice, inputHistoryCursor: -1 })),
        ),

      loadHistory: (sessionId, historyMessages) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            // proxy 每次订阅都重发全量 history, 必须替换而非 append, 否则刷新一次就翻倍
            const historyPrefix = `history-${sessionId}-`;
            const liveMessages = slice.messages.filter((m) => !m.id.startsWith(historyPrefix));
            return {
              ...slice,
              messages: [
                ...historyMessages.map((m, i) => ({
                  id: `${historyPrefix}${i}`,
                  role: m.role,
                  text: m.text,
                  isPartial: false,
                  timestamp: m.timestamp || 0,
                  toolCalls: [],
                })),
                ...liveMessages,
              ],
            };
          }),
        ),

      clearSession: (sessionId) =>
        set((state) => {
          const next = { ...state.bySessionId };
          delete next[sessionId];
          return { bySessionId: next };
        }),

      clearAllSessions: () => set({ bySessionId: {} }),
    }),
    { name: "chat-store" },
  ),
);
