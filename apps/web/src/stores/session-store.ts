// 会话状态管理：会话列表、历史会话
// 选中态不在这里存, 由 URL (/chat/:id) 作为单一事实来源
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  AgentStatusPayload,
  SessionInfo,
  HistorySession,
  PtyStatePayload,
} from "@dev-anywhere/shared";
import {
  readStorageValue,
  removeStorageValue,
  STORAGE_KEYS,
  writeStorageValue,
} from "@/lib/storage-keys";

export type HistoryLoadStatus = "idle" | "loading" | "loaded" | "error";

export interface CodexActiveWriterConflict {
  activeWriterPid?: number;
}

export function ptyAutoYesSessionKey(
  proxyId: string | null | undefined,
  sessionId: string,
): string | null {
  if (!proxyId || !sessionId) return null;
  return `${encodeURIComponent(proxyId)}:${encodeURIComponent(sessionId)}`;
}

function ptyAutoYesKeyBelongsToSession(key: string, sessionId: string): boolean {
  return key.endsWith(`:${encodeURIComponent(sessionId)}`);
}

function readPtyAutoYesBySessionKey(): Record<string, boolean> {
  const raw = readStorageValue("session", STORAGE_KEYS.ptyAutoYesSessions);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, true] => entry[1] === true),
    );
  } catch {
    return {};
  }
}

function writePtyAutoYesBySessionKey(value: Record<string, boolean>): void {
  const enabledEntries = Object.entries(value).filter(([, enabled]) => enabled);
  if (enabledEntries.length === 0) {
    removeStorageValue("session", STORAGE_KEYS.ptyAutoYesSessions);
    return;
  }
  writeStorageValue("session", STORAGE_KEYS.ptyAutoYesSessions, JSON.stringify(value));
}

interface SessionStoreState {
  sessions: SessionInfo[];
  // 首次 session_list envelope 到达前为 false; WS 断开或切换 proxy 时回退 false, 区分"加载中"与"真的没有会话"
  sessionListLoaded: boolean;
  // 已绑定新开发机但 session_list 尚未返回时保留目标名称，避免退化成无上下文的加载态。
  loadingProxyName: string | null;
  historySessions: HistorySession[];
  // 历史扫描独立于活跃 session_list 异步进行。不要把“请求尚未返回”渲染成“确实为空”。
  historyLoadStatus: HistoryLoadStatus;
  // 后发请求/切换开发机使旧请求失效，防止慢响应覆盖新开发机的数据或加载状态。
  historyLoadGeneration: number;
  // PTY 终端标题: Claude CLI 运行时会通过 OSC 0 改终端标题, proxy 抽取后转发 terminal_title
  // chat-header 为 PTY 模式优先展示这个字段, 空则回退到 cwd / sessionId
  ptyTitles: Record<string, string>;
  // PTY 语义元信息: terminal/proxy 从 OSC 等信号抽取。会话生命周期以 sessions[].state 为准。
  ptyStateBySessionId: Record<string, PtyStatePayload>;
  agentStatusBySessionId: Record<string, AgentStatusPayload>;
  // PTY "Always yes" 是用户对某个开发机上的某个会话做出的临时授权，不跟随页面路由重置。
  ptyAutoYesBySessionKey: Record<string, boolean>;
  codexActiveWriterConflict: CodexActiveWriterConflict | null;

  setSessions: (sessions: SessionInfo[]) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (sessionId: string) => void;
  // lastActive 可选：envelope session_status 会一并写入；agent_status 不修改主生命周期时间。
  updateSessionState: (sessionId: string, state: SessionInfo["state"], lastActive?: number) => void;
  setAgentStatus: (sessionId: string, status: AgentStatusPayload) => void;
  setPtyState: (sessionId: string, status: PtyStatePayload) => void;
  updateSessionName: (sessionId: string, name: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setPtyTitle: (sessionId: string, title: string) => void;
  setPtyAutoYes: (sessionKey: string, enabled: boolean) => void;
  setHistorySessions: (sessions: HistorySession[]) => void;
  beginHistoryLoad: () => number;
  resolveHistoryLoad: (generation: number, sessions: HistorySession[]) => boolean;
  rejectHistoryLoad: (generation: number) => boolean;
  cancelHistoryLoad: (generation: number) => boolean;
  prepareForProxySwitch: (proxyName: string) => void;
  revokeProxyAuthorizations: (proxyId: string) => void;
  clearForProxyRemoval: (proxyId: string) => void;
  setCodexActiveWriterConflict: (conflict: CodexActiveWriterConflict | null) => void;
}

export const useSessionStore = create<SessionStoreState>()(
  devtools(
    (set, get) => ({
      sessions: [],
      sessionListLoaded: false,
      loadingProxyName: null,
      historySessions: [],
      historyLoadStatus: "idle",
      historyLoadGeneration: 0,
      ptyTitles: {},
      ptyStateBySessionId: {},
      agentStatusBySessionId: {},
      ptyAutoYesBySessionKey: readPtyAutoYesBySessionKey(),
      codexActiveWriterConflict: null,

      setSessions: (sessions) =>
        set((state) => {
          const activeSessionIds = new Set(sessions.map((session) => session.sessionId));
          return {
            sessions,
            sessionListLoaded: true,
            loadingProxyName: null,
            agentStatusBySessionId: Object.fromEntries(
              Object.entries(state.agentStatusBySessionId).filter(([sid]) =>
                activeSessionIds.has(sid),
              ),
            ),
            ptyStateBySessionId: Object.fromEntries(
              Object.entries(state.ptyStateBySessionId).filter(([sid]) =>
                activeSessionIds.has(sid),
              ),
            ),
            ptyTitles: Object.fromEntries(
              Object.entries(state.ptyTitles).filter(([sid]) => activeSessionIds.has(sid)),
            ),
          };
        }),
      addSession: (session) =>
        set((state) =>
          state.sessions.some((existing) => existing.sessionId === session.sessionId)
            ? state
            : { sessions: [...state.sessions, session] },
        ),
      removeSession: (sessionId) =>
        set((state) => {
          const ptyAutoYesBySessionKey = Object.fromEntries(
            Object.entries(state.ptyAutoYesBySessionKey).filter(
              ([key]) => !ptyAutoYesKeyBelongsToSession(key, sessionId),
            ),
          );
          writePtyAutoYesBySessionKey(ptyAutoYesBySessionKey);
          return {
            sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
            agentStatusBySessionId: Object.fromEntries(
              Object.entries(state.agentStatusBySessionId).filter(([sid]) => sid !== sessionId),
            ),
            ptyStateBySessionId: Object.fromEntries(
              Object.entries(state.ptyStateBySessionId).filter(([sid]) => sid !== sessionId),
            ),
            ptyTitles: Object.fromEntries(
              Object.entries(state.ptyTitles).filter(([sid]) => sid !== sessionId),
            ),
            ptyAutoYesBySessionKey,
          };
        }),
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
      setAgentStatus: (sessionId, status) =>
        set((state) => {
          const current = state.agentStatusBySessionId[sessionId];
          if (current && current.seq > status.seq) return state;
          return {
            agentStatusBySessionId: {
              ...state.agentStatusBySessionId,
              [sessionId]: status,
            },
          };
        }),
      setPtyState: (sessionId, status) =>
        set((state) => {
          const current = state.ptyStateBySessionId[sessionId];
          if (current?.seq !== undefined && status.seq !== undefined && current.seq > status.seq) {
            return state;
          }
          return {
            ptyStateBySessionId: {
              ...state.ptyStateBySessionId,
              [sessionId]: status,
            },
          };
        }),
      updateSessionName: (sessionId, name) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
        })),
      renameSession: (sessionId, name) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, name, nameLocked: true } : s,
          ),
        })),
      setPtyTitle: (sessionId, title) =>
        set((state) => ({
          ptyTitles: { ...state.ptyTitles, [sessionId]: title },
        })),
      setPtyAutoYes: (sessionKey, enabled) =>
        set((state) => {
          const ptyAutoYesBySessionKey = { ...state.ptyAutoYesBySessionKey };
          if (enabled) ptyAutoYesBySessionKey[sessionKey] = true;
          else delete ptyAutoYesBySessionKey[sessionKey];
          writePtyAutoYesBySessionKey(ptyAutoYesBySessionKey);
          return { ptyAutoYesBySessionKey };
        }),
      setHistorySessions: (sessions) =>
        set((state) => ({
          historySessions: sessions,
          historyLoadStatus: "loaded",
          historyLoadGeneration: state.historyLoadGeneration + 1,
        })),
      beginHistoryLoad: () => {
        const generation = get().historyLoadGeneration + 1;
        set({ historyLoadStatus: "loading", historyLoadGeneration: generation });
        return generation;
      },
      resolveHistoryLoad: (generation, sessions) => {
        if (get().historyLoadGeneration !== generation) return false;
        set({ historySessions: sessions, historyLoadStatus: "loaded" });
        return true;
      },
      rejectHistoryLoad: (generation) => {
        if (get().historyLoadGeneration !== generation) return false;
        set({ historyLoadStatus: "error" });
        return true;
      },
      cancelHistoryLoad: (generation) => {
        if (get().historyLoadGeneration !== generation) return false;
        set({ historyLoadStatus: "idle" });
        return true;
      },
      prepareForProxySwitch: (loadingProxyName) =>
        set((state) => ({
          sessions: [],
          sessionListLoaded: false,
          loadingProxyName,
          historySessions: [],
          historyLoadStatus: "idle",
          historyLoadGeneration: state.historyLoadGeneration + 1,
          ptyTitles: {},
          ptyStateBySessionId: {},
          agentStatusBySessionId: {},
          codexActiveWriterConflict: null,
        })),
      revokeProxyAuthorizations: (proxyId) =>
        set((state) => {
          const prefix = `${encodeURIComponent(proxyId)}:`;
          const ptyAutoYesBySessionKey = Object.fromEntries(
            Object.entries(state.ptyAutoYesBySessionKey).filter(([key]) => !key.startsWith(prefix)),
          );
          writePtyAutoYesBySessionKey(ptyAutoYesBySessionKey);
          return { ptyAutoYesBySessionKey };
        }),
      clearForProxyRemoval: (proxyId) =>
        set((state) => {
          const prefix = `${encodeURIComponent(proxyId)}:`;
          const ptyAutoYesBySessionKey = Object.fromEntries(
            Object.entries(state.ptyAutoYesBySessionKey).filter(([key]) => !key.startsWith(prefix)),
          );
          writePtyAutoYesBySessionKey(ptyAutoYesBySessionKey);
          return {
            sessions: [],
            sessionListLoaded: false,
            loadingProxyName: null,
            historySessions: [],
            historyLoadStatus: "idle",
            historyLoadGeneration: state.historyLoadGeneration + 1,
            ptyTitles: {},
            ptyStateBySessionId: {},
            agentStatusBySessionId: {},
            ptyAutoYesBySessionKey,
            codexActiveWriterConflict: null,
          };
        }),
      setCodexActiveWriterConflict: (codexActiveWriterConflict) =>
        set({ codexActiveWriterConflict }),
    }),
    { name: "session-store" },
  ),
);
