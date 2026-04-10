// 聊天消息状态管理：消息列表、流式状态、工具审批队列
import { createContext, useContext } from "react";

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

export interface ChatStoreState {
  messages: ChatMessage[];
  isWorking: boolean;
  pendingApprovals: ToolApprovalRequest[];
  quotedMessage: QuotedMessage | null;
}

export type ChatAction =
  | { type: "APPEND_ASSISTANT_TEXT"; text: string }
  | { type: "ADD_USER_MESSAGE"; message: ChatMessage }
  | { type: "MARK_TURN_COMPLETE" }
  | { type: "ADD_TOOL_CALL"; messageId: string; toolCall: ToolCallInfo }
  | { type: "UPDATE_TOOL_RESULT"; messageId: string; toolName: string; output: string }
  | { type: "TOGGLE_TOOL_COLLAPSE"; messageId: string; toolIndex: number }
  | { type: "ADD_APPROVAL_REQUEST"; request: ToolApprovalRequest }
  | { type: "UPDATE_APPROVAL_STATUS"; requestId: string; status: "approved" | "denied" }
  | { type: "SET_WORKING"; isWorking: boolean }
  | { type: "CLEAR_MESSAGES" }
  | { type: "SET_QUOTE"; quote: QuotedMessage }
  | { type: "CLEAR_QUOTE" };

export const initialChatState: ChatStoreState = {
  messages: [],
  isWorking: false,
  pendingApprovals: [],
  quotedMessage: null,
};

export function chatReducer(state: ChatStoreState, action: ChatAction): ChatStoreState {
  switch (action.type) {
    case "APPEND_ASSISTANT_TEXT": {
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && lastMsg.isPartial) {
        return {
          ...state,
          messages: state.messages.map((m, i) =>
            i === state.messages.length - 1 ? { ...m, text: m.text + action.text } : m,
          ),
        };
      }
      // 没有进行中的 assistant 消息，创建新消息
      const newMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: action.text,
        isPartial: true,
        timestamp: Date.now(),
        toolCalls: [],
      };
      return { ...state, messages: [...state.messages, newMsg] };
    }
    case "ADD_USER_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "MARK_TURN_COMPLETE": {
      const msgs = state.messages.map((m) =>
        m.role === "assistant" && m.isPartial ? { ...m, isPartial: false } : m,
      );
      return { ...state, messages: msgs, isWorking: false };
    }
    case "ADD_TOOL_CALL":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? { ...m, toolCalls: [...m.toolCalls, action.toolCall] }
            : m,
        ),
      };
    case "UPDATE_TOOL_RESULT":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.toolName === action.toolName ? { ...tc, output: action.output } : tc,
                ),
              }
            : m,
        ),
      };
    case "TOGGLE_TOOL_COLLAPSE":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc, i) =>
                  i === action.toolIndex ? { ...tc, collapsed: !tc.collapsed } : tc,
                ),
              }
            : m,
        ),
      };
    case "ADD_APPROVAL_REQUEST":
      return {
        ...state,
        pendingApprovals: [...state.pendingApprovals, action.request],
      };
    case "UPDATE_APPROVAL_STATUS":
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.map((a) =>
          a.requestId === action.requestId ? { ...a, status: action.status } : a,
        ),
      };
    case "SET_WORKING":
      return { ...state, isWorking: action.isWorking };
    case "CLEAR_MESSAGES":
      return { ...state, messages: [], pendingApprovals: [] };
    case "SET_QUOTE":
      return { ...state, quotedMessage: action.quote };
    case "CLEAR_QUOTE":
      return { ...state, quotedMessage: null };
    default:
      return state;
  }
}

const ChatStateContext = createContext<ChatStoreState>(initialChatState);
const ChatDispatchContext = createContext<React.Dispatch<ChatAction>>(() => {
  throw new Error("ChatDispatchContext used outside ChatProvider");
});

export const ChatProvider = ChatStateContext.Provider;
export const ChatDispatchProvider = ChatDispatchContext.Provider;

export function useChatState(): ChatStoreState {
  return useContext(ChatStateContext);
}

export function useChatDispatch(): React.Dispatch<ChatAction> {
  return useContext(ChatDispatchContext);
}
