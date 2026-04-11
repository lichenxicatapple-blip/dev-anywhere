// 会话状态管理：会话列表、当前会话、历史会话
import { createContext, useContext } from "react";
import type { SessionInfo, HistorySession } from "@cc-anywhere/shared";

export type { SessionInfo, HistorySession };

export interface SessionStoreState {
  sessions: SessionInfo[];
  historySessions: HistorySession[];
  currentSessionId: string | null;
  currentSessionMode: "pty" | "json" | null;
}

export type SessionAction =
  | { type: "SET_SESSIONS"; sessions: SessionInfo[] }
  | { type: "SET_CURRENT_SESSION"; sessionId: string | null; mode: "pty" | "json" | null }
  | { type: "ADD_SESSION"; session: SessionInfo }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "UPDATE_SESSION_STATE"; sessionId: string; state: SessionInfo["state"] }
  | { type: "UPDATE_SESSION_NAME"; sessionId: string; name: string }
  | { type: "SET_HISTORY_SESSIONS"; sessions: HistorySession[] };

export const initialSessionState: SessionStoreState = {
  sessions: [],
  historySessions: [],
  currentSessionId: null,
  currentSessionMode: null,
};

export function sessionReducer(state: SessionStoreState, action: SessionAction): SessionStoreState {
  switch (action.type) {
    case "SET_SESSIONS":
      return { ...state, sessions: action.sessions };
    case "SET_CURRENT_SESSION":
      return { ...state, currentSessionId: action.sessionId, currentSessionMode: action.mode };
    case "ADD_SESSION":
      return { ...state, sessions: [...state.sessions, action.session] };
    case "REMOVE_SESSION":
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.sessionId !== action.sessionId),
        currentSessionId:
          state.currentSessionId === action.sessionId ? null : state.currentSessionId,
        currentSessionMode:
          state.currentSessionId === action.sessionId ? null : state.currentSessionMode,
      };
    case "UPDATE_SESSION_STATE":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === action.sessionId ? { ...s, state: action.state } : s,
        ),
      };
    case "UPDATE_SESSION_NAME":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === action.sessionId ? { ...s, name: action.name } : s,
        ),
      };
    case "SET_HISTORY_SESSIONS":
      return { ...state, historySessions: action.sessions };
    default:
      return state;
  }
}

const SessionStateContext = createContext<SessionStoreState>(initialSessionState);
const SessionDispatchContext = createContext<React.Dispatch<SessionAction>>(() => {
  throw new Error("SessionDispatchContext used outside SessionProvider");
});

export const SessionProvider = SessionStateContext.Provider;
export const SessionDispatchProvider = SessionDispatchContext.Provider;

export function useSessionState(): SessionStoreState {
  return useContext(SessionStateContext);
}

export function useSessionDispatch(): React.Dispatch<SessionAction> {
  return useContext(SessionDispatchContext);
}
