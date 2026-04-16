// 会话状态管理：会话列表、当前会话、历史会话
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SessionInfo, HistorySession } from "@cc-anywhere/shared";

interface SessionStoreState {
  sessions: SessionInfo[];
  historySessions: HistorySession[];
  currentSessionId: string | null;
  currentSessionMode: "pty" | "json" | null;

  setSessions: (sessions: SessionInfo[]) => void;
  setCurrentSession: (sessionId: string | null, mode: "pty" | "json" | null) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (sessionId: string) => void;
  updateSessionState: (sessionId: string, state: SessionInfo["state"]) => void;
  updateSessionName: (sessionId: string, name: string) => void;
  setHistorySessions: (sessions: HistorySession[]) => void;
}

export const useSessionStore = create<SessionStoreState>()(
  devtools(
    (set, get) => ({
      sessions: [],
      historySessions: [],
      currentSessionId: null,
      currentSessionMode: null,

      setSessions: (sessions) => set({ sessions }),
      setCurrentSession: (sessionId, mode) =>
        set({ currentSessionId: sessionId, currentSessionMode: mode }),
      addSession: (session) =>
        set((state) => ({ sessions: [...state.sessions, session] })),
      removeSession: (sessionId) => {
        const { currentSessionId } = get();
        set((state) => ({
          sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
          currentSessionId:
            currentSessionId === sessionId ? null : currentSessionId,
          currentSessionMode:
            currentSessionId === sessionId ? null : state.currentSessionMode,
        }));
      },
      updateSessionState: (sessionId, newState) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, state: newState } : s,
          ),
        })),
      updateSessionName: (sessionId, name) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, name } : s,
          ),
        })),
      setHistorySessions: (sessions) => set({ historySessions: sessions }),
    }),
    { name: "session-store" },
  ),
);
