// WebSocket + RelayClient + phase-machine 初始化 hook，应用启动时在 App 组件中调用一次
import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { WebSocketManager } from "@/services/websocket";
import { RelayClient } from "@/services/relay-client";
import {
  handleWsStatusChange,
  handleRelayMessage,
} from "@/services/phase-machine";
import type { Timers } from "@/services/phase-machine";
import { registerChatDispatcher } from "@/services/chat-dispatcher";
import { registerSessionDispatcher } from "@/services/session-dispatcher";

// 模块级单例引用，供 pty-test 等页面直接访问 WebSocket 和 RelayClient 实例
export let wsManagerRef: WebSocketManager | null = null;
export let relayClientRef: RelayClient | null = null;

export function useRelaySetup(): void {
  const wsRef = useRef<WebSocketManager | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const timersRef = useRef<Timers | null>(null);

  useEffect(() => {
    // D-18: relay URL 按优先级解析 localStorage > VITE_RELAY_URL > window.location.origin
    const stored = localStorage.getItem("cc_relayUrl");
    const envUrl = import.meta.env.VITE_RELAY_URL as string | undefined;
    const relayUrl = stored || envUrl || window.location.origin;
    useAppStore.getState().setRelayUrl(relayUrl);

    const ws = new WebSocketManager();
    wsRef.current = ws;
    wsManagerRef = ws;

    const clientId = useAppStore.getState().clientId;
    const relay = new RelayClient(ws, clientId);
    relayRef.current = relay;
    relayClientRef = relay;

    const timers: Timers = { reconnect: null, coldStartDone: false };
    timersRef.current = timers;

    const unsubStatus = ws.onStatusChange((connected) => {
      handleWsStatusChange(connected, timersRef.current!, relayRef.current!);
    });

    const unsubRelay = relay.onMessage((msg) => {
      void handleRelayMessage(
        msg as Record<string, unknown>,
        timersRef.current!,
        relayRef.current!,
      );
    });

    // Chat 模式消息 dispatcher: 订阅 MessageEnvelope + RelayControl chat 类 type, 写 chat-store.
    // 必须在 relayClientRef 赋值后注册 (上方 L35), 否则 registerChatDispatcher 会 no-op 并警告.
    const unregisterChat = registerChatDispatcher();
    // Session 生命周期 dispatcher: session_list / session_status / pty_state / session_history_response → session-store
    const unregisterSession = registerSessionDispatcher();

    // D-08: 页面从后台恢复时自动重连
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        wsRef.current &&
        !wsRef.current.isConnected()
      ) {
        wsRef.current.connect(relayUrl);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    ws.connect(relayUrl);

    return () => {
      unsubStatus();
      unsubRelay();
      unregisterChat();
      unregisterSession();
      document.removeEventListener("visibilitychange", handleVisibility);
      ws.close();
      wsManagerRef = null;
      relayClientRef = null;
    };
  }, []);
}
