// WebSocket + RelayClient + phase-machine 初始化 hook，应用启动时在 App 组件中调用一次
import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { WebSocketManager } from "@/services/websocket";
import { RelayClient } from "@/services/relay-client";
import { handleWsStatusChange, handleRelayMessage } from "@/services/phase-machine";
import type { Timers } from "@/services/phase-machine";
import { registerChatDispatcher } from "@/services/chat-dispatcher";
import { registerSessionDispatcher } from "@/services/session-dispatcher";
import { registerResourceDispatcher } from "@/services/resource-dispatcher";
import { loadFontCSS } from "@/lib/font-assets";

// 模块级单例引用，供 pty-test 等页面直接访问 WebSocket 和 RelayClient 实例
export let wsManagerRef: WebSocketManager | null = null;
export let relayClientRef: RelayClient | null = null;

// 将用户配置的 relayUrl 规整为 /client WebSocket 端点:
// 同域部署默认取 window.location.origin (https://...), 需要转 ws scheme 并补 /client 路径
function toClientWsUrl(relayUrl: string): string {
  const withWsScheme = relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const trimmed = withWsScheme.replace(/\/$/, "");
  const token = getRelayClientToken();
  const base = /\/client$/.test(trimmed) ? trimmed : `${trimmed.replace(/\/proxy$/, "")}/client`;
  if (!token) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(token)}`;
}

function getRelayClientToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("relayToken");
  if (fromUrl) {
    sessionStorage.setItem("cc_relayClientToken", fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem("cc_relayClientToken");
}

export function useRelaySetup(): void {
  const wsRef = useRef<WebSocketManager | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const timersRef = useRef<Timers | null>(null);

  useEffect(() => {
    // dev 经 vite.config.ts server.proxy 把 /client /fonts 反代到 localhost:3100, prod 同域部署走 nginx 分流
    const relayUrl = window.location.origin;
    useAppStore.getState().setRelayUrl(relayUrl);
    loadFontCSS(relayUrl);
    const wsUrl = toClientWsUrl(relayUrl);

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
    // Session 生命周期 dispatcher: session_list / session_status / agent_status / session_history_response → session-store
    const unregisterSession = registerSessionDispatcher();
    // 资源 dispatcher: command_list_push / dir_list_response / file_tree_push → command-store / file-store
    const unregisterResource = registerResourceDispatcher();

    // 页面从后台恢复时立即重连，避免等待指数退避定时器。
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && wsRef.current && !wsRef.current.isConnected()) {
        wsRef.current.connect(wsUrl);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    ws.connect(wsUrl);

    return () => {
      unsubStatus();
      unsubRelay();
      unregisterChat();
      unregisterSession();
      unregisterResource();
      document.removeEventListener("visibilitychange", handleVisibility);
      ws.close();
      wsManagerRef = null;
      relayClientRef = null;
    };
  }, []);
}
