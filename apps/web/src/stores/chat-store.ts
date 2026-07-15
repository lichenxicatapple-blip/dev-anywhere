// 聊天状态管理: 按 sessionId 切片, 每个 slice 含消息/审批/引用/输入草稿
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ChatActivityDetail } from "@/lib/chat-activity-detail";

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

export type ChatActivitySource = "claude-native" | "user-action";
export type ChatActivityKind = "tool" | "marker";
export type ChatActivityStatus = "running" | "done" | "error";

export type { ChatActivityDetail };

export interface ChatActivityInfo {
  id: string;
  source: ChatActivitySource;
  kind: ChatActivityKind;
  status: ChatActivityStatus;
  text: string;
  durable: boolean;
  toolName?: string;
  details?: ChatActivityDetail[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "activity";
  text: string;
  isPartial: boolean;
  timestamp: number;
  toolCalls: ToolCallInfo[];
  deliveryStatus?: "queued";
  quotedMessage?: QuotedMessage;
  activity?: ChatActivityInfo;
}

interface ChatSessionSlice {
  messages: ChatMessage[];
  historyInitialized: boolean;
  historyHasMore: boolean;
  historyNextBefore: string | null;
  historyLoading: boolean;
  // workingToolName 保留：session.state 只到 working 粒度，承载不了具体工具名
  workingToolName: string;
  pendingApprovals: ToolApprovalRequest[];
  quotedMessage: QuotedMessage | null;
  inputDraft: string;
}

export const EMPTY_SLICE: ChatSessionSlice = {
  messages: [],
  historyInitialized: false,
  historyHasMore: false,
  historyNextBefore: null,
  historyLoading: false,
  workingToolName: "",
  pendingApprovals: [],
  quotedMessage: null,
  inputDraft: "",
};

interface ChatStoreState {
  bySessionId: Record<string, ChatSessionSlice>;

  appendAssistantText: (sessionId: string, text: string) => void;
  upsertActivityMessage: (sessionId: string, activity: ChatActivityInfo) => void;
  completeActivityMessage: (
    sessionId: string,
    activityId: string,
    status: Extract<ChatActivityStatus, "done" | "error">,
  ) => void;
  addUserMessage: (sessionId: string, message: ChatMessage) => void;
  upsertUserMessage: (sessionId: string, message: ChatMessage) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  markTurnComplete: (sessionId: string) => void;
  markTurnFailed: (sessionId: string) => void;
  addToolCall: (sessionId: string, messageId: string, toolCall: ToolCallInfo) => void;
  updateToolResult: (
    sessionId: string,
    messageId: string,
    toolIndex: number,
    output: string,
  ) => void;
  toggleToolCollapse: (sessionId: string, messageId: string, toolIndex: number) => void;
  addApprovalRequest: (sessionId: string, request: ToolApprovalRequest) => void;
  replacePendingApprovals: (sessionId: string, requests: ToolApprovalRequest[]) => void;
  updateApprovalStatus: (
    sessionId: string,
    requestId: string,
    status: "approved" | "denied",
  ) => void;
  setWorkingTool: (sessionId: string, toolName: string) => void;
  setQuotedMessage: (sessionId: string, quote: QuotedMessage | null) => void;
  setInputDraft: (sessionId: string, draft: string) => void;
  loadHistory: (
    sessionId: string,
    messages: Array<{
      role: "user" | "assistant" | "system";
      text: string;
      timestamp?: number;
      cursor?: string;
    }>,
  ) => void;
  loadHistoryPage: (
    sessionId: string,
    page: {
      mode: "replace" | "prepend";
      messages: Array<{
        role: "user" | "assistant" | "system";
        text: string;
        timestamp?: number;
        cursor?: string;
      }>;
      hasMore?: boolean;
      nextBefore?: string;
    },
  ) => void;
  setHistoryLoading: (sessionId: string, loading: boolean) => void;
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

function hashHistoryText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function historyMessageId(
  sessionId: string,
  message: {
    role: "user" | "assistant" | "system";
    text: string;
    timestamp?: number;
    cursor?: string;
  },
): string {
  if (message.cursor) return `history-${sessionId}-${message.cursor}`;
  return `history-${sessionId}-${message.timestamp ?? "na"}-${message.role}-${hashHistoryText(
    message.text,
  )}`;
}

function toHistoryChatMessage(
  sessionId: string,
  message: {
    role: "user" | "assistant" | "system";
    text: string;
    timestamp?: number;
    cursor?: string;
  },
): ChatMessage {
  return {
    id: historyMessageId(sessionId, message),
    role: message.role,
    text: message.text,
    isPartial: false,
    timestamp: message.timestamp || 0,
    toolCalls: [],
  };
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const existingIds = new Set(existing.map((message) => message.id));
  return [...incoming.filter((message) => !existingIds.has(message.id)), ...existing];
}

let liveMessageCounter = 0;

function liveMessageId(sessionId: string, role: "assistant" | "activity"): string {
  liveMessageCounter += 1;
  return `${sessionId}-${role}-${Date.now()}-${liveMessageCounter}`;
}

function activityMessageId(sessionId: string, activityId: string): string {
  return `${sessionId}-activity-${activityId}`;
}

function closeAssistantPartials(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "assistant" && m.isPartial ? { ...m, isPartial: false } : m,
  );
}

function completeRunningActivities(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "activity" && m.activity?.status === "running"
      ? {
          ...m,
          isPartial: false,
          activity: { ...m.activity, status: "done" },
        }
      : m,
  );
}

function failRunningActivities(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "activity" && m.activity?.status === "running"
      ? {
          ...m,
          isPartial: false,
          activity: { ...m.activity, status: "error" },
        }
      : m,
  );
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
              id: liveMessageId(sessionId, "assistant"),
              role: "assistant",
              text,
              isPartial: true,
              timestamp: Date.now(),
              toolCalls: [],
            };
            return { ...slice, messages: [...slice.messages, newMsg] };
          }),
        ),

      upsertActivityMessage: (sessionId, activity) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const messageId = activityMessageId(sessionId, activity.id);
            const existingIndex = slice.messages.findIndex((m) => m.id === messageId);
            if (existingIndex >= 0) {
              const next = slice.messages.slice();
              const existing = next[existingIndex];
              next[existingIndex] = {
                ...existing,
                role: "activity",
                text: activity.text,
                isPartial: activity.status === "running",
                timestamp: Date.now(),
                activity,
              };
              return { ...slice, messages: next };
            }
            const newMsg: ChatMessage = {
              id: messageId,
              role: "activity",
              text: activity.text,
              isPartial: activity.status === "running",
              timestamp: Date.now(),
              toolCalls: [],
              activity,
            };
            return { ...slice, messages: [...closeAssistantPartials(slice.messages), newMsg] };
          }),
        ),

      completeActivityMessage: (sessionId, activityId, status) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: slice.messages.map((m) =>
              m.role === "activity" && m.activity?.id === activityId
                ? {
                    ...m,
                    isPartial: false,
                    activity: { ...m.activity, status },
                  }
                : m,
            ),
          })),
        ),

      addUserMessage: (sessionId, message) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            if (slice.messages.some((m) => m.id === message.id)) return slice;
            return {
              ...slice,
              messages: [...slice.messages, message],
            };
          }),
        ),

      upsertUserMessage: (sessionId, message) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const index = slice.messages.findIndex((m) => m.id === message.id);
            if (index === -1) {
              return { ...slice, messages: [...slice.messages, message] };
            }
            const next = slice.messages.slice();
            next[index] = message;
            return { ...slice, messages: next };
          }),
        ),

      removeMessage: (sessionId, messageId) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const next = slice.messages.filter((m) => m.id !== messageId);
            if (next.length === slice.messages.length) return slice;
            return { ...slice, messages: next };
          }),
        ),

      markTurnComplete: (sessionId) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: completeRunningActivities(closeAssistantPartials(slice.messages)),
            workingToolName: "",
            pendingApprovals: [],
          })),
        ),

      markTurnFailed: (sessionId) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            messages: failRunningActivities(closeAssistantPartials(slice.messages)),
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

      // 按 requestId 去重：proxy worker 在 serve 重启或 socket 瞬断重连时会重发 pending，
      // 同一 requestId 的 tool_use_request envelope 合法地到达多次；UI 必须幂等，否则出现重复卡片。
      addApprovalRequest: (sessionId, request) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const existing = slice.pendingApprovals.find((a) => a.requestId === request.requestId);
            if (existing) return slice;
            return { ...slice, pendingApprovals: [...slice.pendingApprovals, request] };
          }),
        ),

      replacePendingApprovals: (sessionId, requests) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({
            ...slice,
            pendingApprovals: requests,
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

      loadHistory: (sessionId, historyMessages) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const historyMessagesNext = historyMessages.map((m) =>
              toHistoryChatMessage(sessionId, m),
            );
            const liveMessages = slice.messages.filter(
              (m) => !m.id.startsWith(`history-${sessionId}-`),
            );
            return {
              ...slice,
              messages: [...historyMessagesNext, ...liveMessages],
              historyInitialized: true,
              historyHasMore: false,
              historyNextBefore: null,
              historyLoading: false,
            };
          }),
        ),

      loadHistoryPage: (sessionId, page) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => {
            const historyPrefix = `history-${sessionId}-`;
            const historyMessages = page.messages.map((m) => toHistoryChatMessage(sessionId, m));
            const nextMessages =
              page.mode === "replace"
                ? [
                    ...historyMessages,
                    ...slice.messages.filter((m) => !m.id.startsWith(historyPrefix)),
                  ]
                : mergeMessages(slice.messages, historyMessages);
            return {
              ...slice,
              messages: nextMessages,
              historyInitialized: true,
              historyHasMore: page.hasMore ?? false,
              historyNextBefore: page.nextBefore ?? null,
              historyLoading: false,
            };
          }),
        ),

      setHistoryLoading: (sessionId, loading) =>
        set((state) =>
          updateSlice(state, sessionId, (slice) => ({ ...slice, historyLoading: loading })),
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
