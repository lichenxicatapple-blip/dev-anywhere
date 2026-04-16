// 聊天消息状态管理：消息列表、流式状态、工具审批队列
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

interface ChatStoreState {
  messages: ChatMessage[];
  isWorking: boolean;
  workingToolName: string;
  pendingApprovals: ToolApprovalRequest[];
  quotedMessage: QuotedMessage | null;

  appendAssistantText: (text: string) => void;
  addUserMessage: (message: ChatMessage) => void;
  markTurnComplete: () => void;
  addToolCall: (messageId: string, toolCall: ToolCallInfo) => void;
  updateToolResult: (messageId: string, toolIndex: number, output: string) => void;
  toggleToolCollapse: (messageId: string, toolIndex: number) => void;
  addApprovalRequest: (request: ToolApprovalRequest) => void;
  updateApprovalStatus: (requestId: string, status: "approved" | "denied") => void;
  setWorking: (isWorking: boolean) => void;
  setWorkingTool: (toolName: string) => void;
  clearMessages: () => void;
  setQuote: (quote: QuotedMessage) => void;
  clearQuote: () => void;
  loadHistory: (messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>) => void;
}

export const useChatStore = create<ChatStoreState>()(
  devtools(
    (set, get) => ({
      messages: [],
      isWorking: false,
      workingToolName: "",
      pendingApprovals: [],
      quotedMessage: null,

      appendAssistantText: (text) => {
        const { messages } = get();
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.isPartial) {
          set({
            messages: messages.map((m, i) =>
              i === messages.length - 1 ? { ...m, text: m.text + text } : m,
            ),
          });
        } else {
          const newMsg: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text,
            isPartial: true,
            timestamp: Date.now(),
            toolCalls: [],
          };
          set({ messages: [...messages, newMsg] });
        }
      },

      addUserMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      markTurnComplete: () =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.role === "assistant" && m.isPartial ? { ...m, isPartial: false } : m,
          ),
          isWorking: false,
          workingToolName: "",
          pendingApprovals: [],
        })),

      addToolCall: (messageId, toolCall) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === messageId
              ? { ...m, toolCalls: [...m.toolCalls, toolCall] }
              : m,
          ),
        })),

      updateToolResult: (messageId, toolIndex, output) =>
        set((state) => ({
          messages: state.messages.map((m) =>
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

      toggleToolCollapse: (messageId, toolIndex) =>
        set((state) => ({
          messages: state.messages.map((m) =>
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

      addApprovalRequest: (request) =>
        set((state) => ({
          pendingApprovals: [...state.pendingApprovals, request],
        })),

      updateApprovalStatus: (requestId, status) =>
        set((state) => ({
          pendingApprovals: state.pendingApprovals.map((a) =>
            a.requestId === requestId ? { ...a, status } : a,
          ),
        })),

      setWorking: (isWorking) =>
        set((state) => ({
          isWorking,
          workingToolName: isWorking ? state.workingToolName : "",
        })),

      setWorkingTool: (toolName) => set({ workingToolName: toolName }),

      clearMessages: () => set({ messages: [], pendingApprovals: [] }),

      setQuote: (quote) => set({ quotedMessage: quote }),

      clearQuote: () => set({ quotedMessage: null }),

      loadHistory: (historyMessages) =>
        set((state) => ({
          messages: [
            ...historyMessages.map((m, i) => ({
              id: `history-${i}`,
              role: m.role,
              text: m.text,
              isPartial: false,
              timestamp: m.timestamp || 0,
              toolCalls: [],
            })),
            ...state.messages,
          ],
        })),
    }),
    { name: "chat-store" },
  ),
);
