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
import { checkRelayClientAuth } from "@/lib/relay-client-auth";
import type { RelayClientAuthIssue } from "@/lib/relay-client-auth";
import {
  clearRelayClientToken,
  getRelayClientToken,
  toClientWsUrl,
} from "@/lib/relay-client-token";

// 模块级单例引用，供 pty-test 等页面直接访问 WebSocket 和 RelayClient 实例
const RELAY_RUNTIME_KEY = "__devAnywhereRelayRuntime";

interface RelayRuntime {
  wsManagerRef: WebSocketManager | null;
  relayClientRef: RelayClient | null;
}

function relayRuntime(): RelayRuntime {
  const host = globalThis as typeof globalThis & { [RELAY_RUNTIME_KEY]?: RelayRuntime };
  host[RELAY_RUNTIME_KEY] ??= { wsManagerRef: null, relayClientRef: null };
  return host[RELAY_RUNTIME_KEY];
}

export let wsManagerRef: WebSocketManager | null = relayRuntime().wsManagerRef;
export let relayClientRef: RelayClient | null = relayRuntime().relayClientRef;

function setRuntimeRefs(refs: RelayRuntime): void {
  const runtime = relayRuntime();
  runtime.wsManagerRef = refs.wsManagerRef;
  runtime.relayClientRef = refs.relayClientRef;
  wsManagerRef = refs.wsManagerRef;
  relayClientRef = refs.relayClientRef;
}

function applyRelayClientAuthIssue(authIssue: RelayClientAuthIssue): void {
  if (authIssue === "invalid_client_token") clearRelayClientToken();
  const store = useAppStore.getState();
  store.setRelayClientAuthIssue(authIssue);
  store.setConnected(false);
  store.setProxyOnline(false);
  store.setProxy(null, null);
  store.setProxies([]);
  store.setPhase("proxy_selecting");
}

export async function reconnectRelayClient(signal?: AbortSignal): Promise<void> {
  const ws = wsManagerRef;
  if (!ws) return;
  const relayUrl = useAppStore.getState().relayUrl || window.location.origin;
  const token = getRelayClientToken();
  let authIssue: RelayClientAuthIssue | null;
  try {
    authIssue = await checkRelayClientAuth(relayUrl, token, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  }
  if (authIssue) {
    applyRelayClientAuthIssue(authIssue);
    return;
  }
  useAppStore.getState().setRelayClientAuthIssue(null);
  ws.connect(toClientWsUrl(relayUrl));
}

export function useRelaySetup(): void {
  const wsRef = useRef<WebSocketManager | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const timersRef = useRef<Timers | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    // dev 经 vite.config.ts server.proxy 把 /client /fonts 反代到 localhost:3100, prod 同域部署走 nginx 分流
    const relayUrl = window.location.origin;
    useAppStore.getState().setRelayUrl(relayUrl);
    loadFontCSS(relayUrl);

    const ws = new WebSocketManager();
    wsRef.current = ws;

    const clientId = useAppStore.getState().clientId;
    const relay = new RelayClient(ws, clientId);
    relayRef.current = relay;
    setRuntimeRefs({ wsManagerRef: ws, relayClientRef: relay });

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

    void reconnectRelayClient(abort.signal).finally(() => {
      if (disposed) ws.close();
    });

    return () => {
      disposed = true;
      abort.abort();
      unsubStatus();
      unsubRelay();
      unregisterChat();
      unregisterSession();
      unregisterResource();
      ws.close();
      setRuntimeRefs({ wsManagerRef: null, relayClientRef: null });
    };
  }, []);
}
