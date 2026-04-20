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

// 模块级单例引用，供 pty-test 等页面直接访问 WebSocket 和 RelayClient 实例
export let wsManagerRef: WebSocketManager | null = null;
export let relayClientRef: RelayClient | null = null;

// Sarasa Fixed SC 按 cn-font-split 分片托管在 relay, 按 unicode-range 按需下载
// relay 静态目录 ~/.cc-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css 由 CJK font hosting 预生成
function loadFontCSS(relayUrl: string): void {
  const base = relayUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/(proxy|client)$/, "");
  const href = `${base}/fonts/sarasa-fixed-sc/result.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

// 将用户配置的 relayUrl 规整为 /client WebSocket 端点:
// 同域部署默认取 window.location.origin (https://...), 需要转 ws scheme 并补 /client 路径
function toClientWsUrl(relayUrl: string): string {
  const withWsScheme = relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const trimmed = withWsScheme.replace(/\/$/, "");
  if (/\/client$/.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/proxy$/, "")}/client`;
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
    // Session 生命周期 dispatcher: session_list / session_status / pty_state / session_history_response → session-store
    const unregisterSession = registerSessionDispatcher();
    // 资源 dispatcher: command_list_push / dir_list_response / file_tree_push → command-store / file-store
    const unregisterResource = registerResourceDispatcher();

    // D-08: 页面从后台恢复时自动重连
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
