// 会话列表页：活跃/历史分区，左滑终止，状态圆点，模式标记，新建会话带目录选择
import { useState, useEffect, useCallback, useMemo } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { MessageEnvelope, RelayControlMessage, DirEntry, SessionInfo } from "@cc-anywhere/shared";
import { showToast, showErrorToast } from "@/components/toast";
import { useRelayClient } from "@/stores/relay-store";
import { useAppState, useAppDispatch, transitionToPhase } from "@/stores/app-store";
import {
  useSessionState,
  useSessionDispatch,
} from "@/stores/session-store";
import type { HistorySession } from "@/stores/session-store";
import { useFileState, useFileDispatch } from "@/stores/file-store";
import { useScreenSize } from "@/hooks/use-screen-size";
import { SessionListItem, HistoryListItem } from "@/components/session-list-item";
import { EmptyState } from "@/components/empty-state";
import { DirectoryPicker } from "@/components/directory-picker";
import "./index.css";

export default function SessionList() {
  const relay = useRelayClient();
  const appState = useAppState();
  const appDispatch = useAppDispatch();
  const sessionState = useSessionState();
  const sessionDispatch = useSessionDispatch();
  const fileState = useFileState();
  const fileDispatch = useFileDispatch();
  const screen = useScreenSize();
  const [swipeOpenId, setSwipeOpenId] = useState("");
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [creating, setCreating] = useState(false);

  // 设置导航栏标题为 proxy 名称
  useEffect(() => {
    if (appState.selectedProxyName) {
      Taro.setNavigationBarTitle({ title: appState.selectedProxyName });
    }
  }, [appState.selectedProxyName]);

  // 请求会话列表和历史会话
  useEffect(() => {
    if (!relay) return;

    const unsub = relay.onMessage((msg) => {
      // session_list 是 MessageEnvelope 类型
      if (msg.type === "session_list" && "payload" in msg) {
        const env = msg as MessageEnvelope & { payload: { sessions: SessionInfo[] } };
        sessionDispatch({ type: "SET_SESSIONS", sessions: env.payload.sessions });
      }
      // session_status 是 MessageEnvelope 类型，实时更新单个会话状态
      if (msg.type === "session_status" && "payload" in msg) {
        const env = msg as MessageEnvelope & { payload: { sessionId: string; state: string } };
        sessionDispatch({
          type: "UPDATE_SESSION_STATE",
          sessionId: env.payload.sessionId,
          state: env.payload.state as SessionInfo["state"],
        });
      }

      const ctrl = msg as RelayControlMessage;
      // pty_state 实时更新 session 状态（working/idle/approval）
      if (ctrl.type === "pty_state" && "sessionId" in ctrl && "payload" in ctrl) {
        const { sessionId: sid, payload } = ctrl as unknown as { sessionId: string; payload: { state: string } };
        const stateMap: Record<string, string> = { working: "working", turn_complete: "idle", approval_wait: "waiting_approval" };
        const mapped = stateMap[payload.state];
        if (mapped) {
          sessionDispatch({ type: "UPDATE_SESSION_STATE", sessionId: sid, state: mapped as SessionInfo["state"] });
        }
      }
      if (ctrl.type === "session_history_response") {
        sessionDispatch({ type: "SET_HISTORY_SESSIONS", sessions: ctrl.sessions });
      }
      // 目录列表响应
      if (ctrl.type === "dir_list_response") {
        const { path, entries } = ctrl as RelayControlMessage & { path: string; entries: DirEntry[] };
        fileDispatch({ type: "SET_DIR_ENTRIES", path, entries });
      }
      // 会话创建响应：导航到 chat 页面
      if (ctrl.type === "session_create_response") {
        setCreating(false);
        const resp = ctrl as unknown as { sessionId: string; error?: string };
        if (resp.error) {
          showErrorToast(resp.error);
        } else {
          Taro.setStorageSync("cc_sessionId", resp.sessionId);
          Taro.setStorageSync("cc_sessionMode", "json");
          transitionToPhase(appState.phase, "chatting", appDispatch);
          Taro.navigateTo({ url: `/pages/chat/index?sessionId=${resp.sessionId}&mode=json` });
        }
      }
      // relay 错误提示
      if (ctrl.type === "relay_error") {
        const err = ctrl as Record<string, unknown>;
        showErrorToast(`${err.message || err.code}`);
      }
      // 目录创建响应：创建成功后刷新父目录缓存
      if (ctrl.type === "dir_create_response") {
        const resp = ctrl as unknown as { path: string; success: boolean; error?: string };
        if (resp.success) {
          const parentPath = resp.path.replace(/\/[^/]+\/?$/, "") || "/";
          fileDispatch({ type: "SET_DIR_ENTRIES", path: parentPath, entries: [] });
          if (relay) relay.sendControl({ type: "dir_list_request", path: parentPath });
        }
      }
    });

    // 连接建立后才发请求，避免在 WebSocket 未就绪时发送被丢弃
    if (appState.connected) {
      relay.sendControl({ type: "session_list" });
      relay.sendControl({ type: "session_history_request" });
    }

    return unsub;
  }, [relay, appState.connected, sessionDispatch, fileDispatch]);

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

  // 左滑切换
  const handleSwipeToggle = useCallback((id: string) => {
    setSwipeOpenId((prev) => (prev === id ? "" : id));
  }, []);

  // 点击活跃会话，进入聊天页
  const handleSelectSession = useCallback(
    (sessionId: string, mode: "pty" | "json" | undefined, name?: string) => {
      Taro.setStorageSync("cc_sessionId", sessionId);
      Taro.setStorageSync("cc_sessionMode", mode || "json");
      sessionDispatch({
        type: "SET_CURRENT_SESSION",
        sessionId,
        mode: mode || "json",
      });
      transitionToPhase(appState.phase, "chatting", appDispatch);
      const nameParam = name ? `&name=${encodeURIComponent(name)}` : "";
      Taro.navigateTo({ url: `/pages/chat/index?sessionId=${sessionId}&mode=${mode || "json"}${nameParam}` });
    },
    [sessionDispatch, appState.phase, appDispatch],
  );

  // 终止 JSON 会话
  const handleTerminate = useCallback(
    (sessionId: string) => {
      if (!checkConnected()) return;
      if (relay) {
        relay.sendControl({ type: "session_terminate", sessionId } as never);
      }
      sessionDispatch({ type: "REMOVE_SESSION", sessionId });
    },
    [relay, sessionDispatch, checkConnected],
  );

  // 恢复历史会话：用 projectDir 作为 cwd，传 Claude 会话 ID 给 --resume
  const handleResumeHistory = useCallback(
    (historySession: HistorySession) => {
      if (!checkConnected()) return;
      if (relay) {
        setCreating(true);
        relay.sendControl({
          type: "session_create",
          cwd: historySession.projectDir,
          resumeSessionId: historySession.id,
        } as never);
      }
    },
    [relay, checkConnected],
  );

  // 点击新建按钮时弹出目录选择器
  const handleNewSessionPress = useCallback(() => {
    setShowDirPicker(true);
  }, []);

  // 请求目录列表
  const handleRequestDir = useCallback(
    (path: string) => {
      if (!checkConnected()) return;
      if (relay) {
        relay.sendControl({ type: "dir_list_request", path });
      }
    },
    [relay, checkConnected],
  );

  // 选择目录后创建会话，等待 session_create_response 返回 sessionId 再导航
  const handleDirSelect = useCallback(
    (cwd: string) => {
      setShowDirPicker(false);
      if (!checkConnected()) return;
      if (relay) {
        setCreating(true);
        relay.sendControl({ type: "session_create", cwd } as never);
      }
    },
    [relay, checkConnected],
  );

  const handleDirPickerCancel = useCallback(() => {
    setShowDirPicker(false);
  }, []);

  const handleCreateDir = useCallback(
    (path: string) => {
      if (!checkConnected() || !relay) return;
      relay.sendControl({ type: "dir_create_request", path } as never);
    },
    [relay, checkConnected],
  );

  const hasActiveSessions = sessionState.sessions.length > 0;
  const hasHistory = sessionState.historySessions.length > 0;
  const isEmpty = !hasActiveSessions && !hasHistory;

  // 历史会话按 projectDir 分组
  const historyGroups = useMemo(() => {
    const groups = new Map<string, typeof sessionState.historySessions>();
    for (const h of sessionState.historySessions) {
      const dir = h.projectDir;
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(h);
    }
    return Array.from(groups.entries()).map(([dir, sessions]) => ({
      dir,
      shortDir: dir.replace(/^\/Users\/[^/]+/, "~"),
      sessions,
    }));
  }, [sessionState.historySessions]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((dir: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  return (
    <View className={`session-page ${screen.className}`}>
      <ScrollView className="session-scroll" scrollY>
        {isEmpty ? (
          <EmptyState
            title="No Active Sessions"
            subtitle="Create a new session or connect from your computer"
            ctaText="New Session"
            onCta={handleNewSessionPress}
          />
        ) : (
          <View className="session-list-container">
            {hasActiveSessions && (
              <View>
                <Text className="session-section-header">Active Sessions</Text>
                {sessionState.sessions.map((s) => (
                  <SessionListItem
                    key={s.sessionId}
                    session={s}
                    swipeOpen={swipeOpenId === s.sessionId}
                    onSwipeToggle={handleSwipeToggle}
                    onSelect={() => handleSelectSession(s.sessionId, s.mode, s.name)}
                    onTerminate={() => handleTerminate(s.sessionId)}
                  />
                ))}
              </View>
            )}

            {hasActiveSessions && hasHistory && (
              <View className="session-section-divider" />
            )}
            {hasHistory && (
              <View>
                <Text className="session-section-header">History</Text>
                {historyGroups.map((group) => (
                  <View key={group.dir} className="history-group">
                    <View className="history-group-header" onClick={() => toggleGroup(group.dir)}>
                      <View className={`history-group-chevron ${expandedGroups.has(group.dir) ? "expanded" : ""}`} />
                      <Text className="history-group-path">{group.shortDir}</Text>
                      <Text className="history-group-count">{group.sessions.length}</Text>
                    </View>
                    {expandedGroups.has(group.dir) && (
                      <View className="history-group-items">
                        {group.sessions.map((h) => (
                          <HistoryListItem
                            key={h.id}
                            id={h.id}
                            title={h.title}
                            projectDir={h.projectDir}
                            updatedAt={h.updatedAt}
                            onSelect={() => handleResumeHistory(h)}
                          />
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Loading overlay */}
      {creating && (
        <View className="session-loading-overlay">
          <View className="session-loading-ring">
            <View className="session-loading-dot" />
            <View className="session-loading-dot" />
            <View className="session-loading-dot" />
            <View className="session-loading-dot" />
            <View className="session-loading-dot" />
          </View>
          <Text className="session-loading-text">Creating session...</Text>
        </View>
      )}

      {/* Floating action button for new session */}
      <View className="session-fab" onClick={handleNewSessionPress}>
        <Text className="session-fab-text">+</Text>
      </View>

      {/* Directory picker modal for new session cwd selection */}
      <DirectoryPicker
        visible={showDirPicker}
        onSelect={handleDirSelect}
        onCancel={handleDirPickerCancel}
        onRequestDir={handleRequestDir}
        onCreateDir={handleCreateDir}
        dirEntries={fileState.tree}
      />
    </View>
  );
}
