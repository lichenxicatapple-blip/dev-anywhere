// 会话状态管理：会话列表、历史会话
// 选中态不在这里存, 由 URL (/chat/:id) 作为单一事实来源
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { SessionInfo, HistorySession } from "@cc-anywhere/shared";

interface SessionStoreState {
  sessions: SessionInfo[];
  // 首次 session_list envelope 到达前为 false; WS 断开或切换 proxy 时回退 false, 区分"加载中"与"真的没有会话"
  sessionListLoaded: boolean;
  historySessions: HistorySession[];
  // PTY 终端标题: Claude CLI 运行时会通过 OSC 0 改终端标题, proxy 抽取后转发 terminal_title
  // chat-header 为 PTY 模式优先展示这个字段, 空则回退到 cwd / sessionId
  ptyTitles: Record<string, string>;

  setSessions: (sessions: SessionInfo[]) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (sessionId: string) => void;
  // lastActive 可选：PTY 控制消息 pty_state 无此字段，envelope session_status 则会一并写入
  updateSessionState: (
    sessionId: string,
    state: SessionInfo["state"],
    lastActive?: number,
  ) => void;
  updateSessionName: (sessionId: string, name: string) => void;
  setPtyTitle: (sessionId: string, title: string) => void;
  setHistorySessions: (sessions: HistorySession[]) => void;
}

export const useSessionStore = create<SessionStoreState>()(
  devtools(
    (set) => ({
      sessions: [],
      sessionListLoaded: false,
      historySessions: [],
      ptyTitles: {},

      setSessions: (sessions) => set({ sessions, sessionListLoaded: true }),
      addSession: (session) =>
        set((state) => ({ sessions: [...state.sessions, session] })),
      removeSession: (sessionId) =>
        set((state) => ({
          sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
        })),
      updateSessionState: (sessionId, newState, lastActive) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId
              ? {
                  ...s,
                  state: newState,
                  ...(lastActive !== undefined ? { lastActive } : {}),
                }
              : s,
          ),
        })),
      updateSessionName: (sessionId, name) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, name } : s,
          ),
        })),
      setPtyTitle: (sessionId, title) =>
        set((state) => ({
          ptyTitles: { ...state.ptyTitles, [sessionId]: title },
        })),
      setHistorySessions: (sessions) => set({ historySessions: sessions }),
    }),
    { name: "session-store" },
  ),
);
