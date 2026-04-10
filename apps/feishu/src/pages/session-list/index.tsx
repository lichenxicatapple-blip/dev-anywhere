// 会话列表页：活跃/历史分区，左滑终止，状态圆点，模式标记，新建会话 FAB
import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { RelayControlMessage, HistorySession } from "@cc-anywhere/shared";
import { useRelayClient } from "@/stores/relay-store";
import { useAppState } from "@/stores/app-store";
import {
  useSessionState,
  useSessionDispatch,
} from "@/stores/session-store";
import { useScreenSize } from "@/hooks/use-screen-size";
import { StatusLine } from "@/components/status-line";
import { SessionListItem, HistoryListItem } from "@/components/session-list-item";
import { EmptyState } from "@/components/empty-state";
import "./index.css";

export default function SessionList() {
  const relay = useRelayClient();
  const appState = useAppState();
  const sessionState = useSessionState();
  const sessionDispatch = useSessionDispatch();
  const screen = useScreenSize();
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [swipeOpenId, setSwipeOpenId] = useState("");

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
      const ctrl = msg as RelayControlMessage;
      if (ctrl.type === "session_history_response") {
        setHistorySessions(ctrl.sessions);
      }
    });

    // 发送请求获取会话列表和历史
    relay.sendControl({ type: "session_list" });
    relay.sendControl({ type: "session_history_request" });

    return unsub;
  }, [relay]);

  // 左滑切换
  const handleSwipeToggle = useCallback((id: string) => {
    setSwipeOpenId((prev) => (prev === id ? "" : id));
  }, []);

  // 点击活跃会话，进入聊天页
  const handleSelectSession = useCallback(
    (sessionId: string, mode: "pty" | "json" | undefined) => {
      Taro.setStorageSync("cc_sessionId", sessionId);
      sessionDispatch({
        type: "SET_CURRENT_SESSION",
        sessionId,
        mode: mode || "json",
      });
      Taro.navigateTo({ url: "/pages/chat/index" });
    },
    [sessionDispatch],
  );

  // 终止 JSON 会话
  const handleTerminate = useCallback(
    (sessionId: string) => {
      if (relay) {
        relay.sendEnvelope({
          type: "session_terminate",
          sessionId,
          payload: { sessionId },
        } as never);
      }
      sessionDispatch({ type: "REMOVE_SESSION", sessionId });
    },
    [relay, sessionDispatch],
  );

  // 恢复历史会话
  const handleResumeHistory = useCallback(
    (historySession: HistorySession) => {
      if (relay) {
        relay.sendEnvelope({
          type: "session_create",
          sessionId: "",
          payload: { resumeSessionId: historySession.id },
        } as never);
      }
      Taro.navigateTo({ url: "/pages/chat/index" });
    },
    [relay],
  );

  // 新建会话
  const handleNewSession = useCallback(() => {
    if (relay) {
      relay.sendEnvelope({
        type: "session_create",
        sessionId: "",
        payload: {},
      } as never);
    }
    Taro.navigateTo({ url: "/pages/chat/index" });
  }, [relay]);

  // 推导当前整体状态用于 StatusLine
  const overallState = sessionState.sessions.some((s) => s.state === "working")
    ? "working"
    : sessionState.sessions.some((s) => s.state === "waiting_approval")
      ? "waiting_approval"
      : sessionState.sessions.some((s) => s.state === "idle")
        ? "idle"
        : "terminated";

  const hasActiveSessions = sessionState.sessions.length > 0;
  const hasHistory = historySessions.length > 0;
  const isEmpty = !hasActiveSessions && !hasHistory;

  return (
    <View className={`session-page ${screen.className}`}>
      <StatusLine state={overallState} />
      <ScrollView className="session-scroll" scrollY>
        {isEmpty ? (
          <EmptyState
            title="No Active Sessions"
            subtitle="Create a new session or connect from your computer"
            ctaText="New Session"
            onCta={handleNewSession}
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
                    onSelect={() => handleSelectSession(s.sessionId, s.mode)}
                    onTerminate={() => handleTerminate(s.sessionId)}
                  />
                ))}
              </View>
            )}

            {hasHistory && (
              <View>
                <Text className="session-section-header">History Sessions</Text>
                <View className="session-history-grid">
                  {historySessions.map((h) => (
                    <HistoryListItem
                      key={h.id}
                      id={h.id}
                      title={h.title}
                      updatedAt={h.updatedAt}
                      onSelect={() => handleResumeHistory(h)}
                    />
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Floating action button for new session */}
      <View className="session-fab" onClick={handleNewSession}>
        <Text className="session-fab-text">+</Text>
      </View>
    </View>
  );
}
