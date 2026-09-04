// WebSocket + RelayClient + phase-machine 初始化 hook，应用启动时在 App 组件中调用一次
import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { WebSocketManager } from "@/services/websocket";
import { RelayClient } from "@/services/relay-client";
import {
  createPhaseMachineTimers,
  disposePhaseMachineTimers,
  handleWsStatusChange,
  handleRelayMessage,
} from "@/services/phase-machine";
import type { Timers } from "@/services/phase-machine";
import { registerChatDispatcher } from "@/services/chat-dispatcher";
import { registerSessionDispatcher } from "@/services/session-dispatcher";
import { registerResourceDispatcher } from "@/services/resource-dispatcher";
import { registerPreviewDispatcher } from "@/services/preview-dispatcher";
import { previewController } from "@/services/preview-controller";
import { loadFontCSS } from "@/lib/font-assets";
import { checkRelayClientAuth } from "@/lib/relay-client-auth";
import type { RelayClientAuthIssue } from "@/lib/relay-client-auth";
import {
  createRelayReconnectLoop,
  RelayReconnectAttemptTimeoutError,
  type RelayReconnectLoop,
} from "@/services/relay-reconnect-loop";
import {
  clearRelayClientToken,
  consumeRelayClientTokenFromFragment,
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
let relayReconnectGeneration = 0;
let activeRelayReconnectController: AbortController | null = null;
let activeRelayReconnectLoop: RelayReconnectLoop | null = null;

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
  store.setRelayConnectionIssue(null);
  store.setConnected(false);
  store.setProxyOnline(false);
  store.setProxy(null, null);
  store.setProxies([]);
  store.setPhase("proxy_selecting");
  previewController.dispose();
}

function prepareRelayReconnect(): void {
  const store = useAppStore.getState();
  const hasSelectedProxy = store.selectedProxyId !== null;
  store.setConnected(false);
  store.setProxyOnline(false);
  store.invalidateProxyList();
  previewController.dispose();

  if (hasSelectedProxy) {
    if (store.phase !== "reconnecting") store.setPhase("reconnecting");
  } else {
    store.setPhase("connecting");
  }
}

export async function reconnectRelayClient(signal?: AbortSignal): Promise<void> {
  const ws = wsManagerRef;
  if (!ws) return;
  const generation = ++relayReconnectGeneration;
  activeRelayReconnectController?.abort(
    new DOMException("Superseded by a newer Relay connection attempt", "AbortError"),
  );
  const attemptController = new AbortController();
  activeRelayReconnectController = attemptController;
  const abortFromParent = (): void => attemptController.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const attemptSignal = attemptController.signal;
  const ownTimeout = signal
    ? null
    : setTimeout(() => {
        const error = new RelayReconnectAttemptTimeoutError();
        attemptController.abort(error);
      }, 5_000);
  const isCurrent = (): boolean => generation === relayReconnectGeneration;
  const relayUrl = useAppStore.getState().relayUrl || window.location.origin;
  const token = getRelayClientToken();
  let authIssue: RelayClientAuthIssue | null;
  try {
    authIssue = await checkRelayClientAuth(relayUrl, token, attemptSignal);
  } catch (err) {
    if (
      !isCurrent() ||
      (signal?.aborted && !(signal.reason instanceof RelayReconnectAttemptTimeoutError))
    ) {
      return;
    }
    useAppStore.getState().setRelayConnectionIssue("unreachable");
    // A manual attempt has no owning retry cycle. Hand recovery back to the restartable startup
    // supervisor so the unavailable screen never claims to retry while no retry is scheduled.
    if (!signal) activeRelayReconnectLoop?.start();
    if (attemptSignal.reason instanceof RelayReconnectAttemptTimeoutError) {
      throw attemptSignal.reason;
    }
    throw err;
  } finally {
    if (ownTimeout) clearTimeout(ownTimeout);
    signal?.removeEventListener("abort", abortFromParent);
    if (activeRelayReconnectController === attemptController) {
      activeRelayReconnectController = null;
    }
  }
  if (!isCurrent()) return;
  if (attemptSignal.aborted) {
    if (attemptSignal.reason instanceof RelayReconnectAttemptTimeoutError) {
      useAppStore.getState().setRelayConnectionIssue("unreachable");
      throw attemptSignal.reason;
    }
    return;
  }
  useAppStore.getState().setRelayConnectionIssue(null);
  if (authIssue) {
    applyRelayClientAuthIssue(authIssue);
    if (!signal) activeRelayReconnectLoop?.stop();
    return;
  }
  useAppStore.getState().setRelayClientAuthIssue(null);
  prepareRelayReconnect();
  ws.connect(toClientWsUrl(relayUrl));
  // A successful user-triggered reconnect supersedes any retry which the cold-start loop already
  // scheduled. Attempts owned by that loop carry its signal and stop naturally after success.
  if (!signal) activeRelayReconnectLoop?.stop();
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
    consumeRelayClientTokenFromFragment();

    const ws = new WebSocketManager();
    wsRef.current = ws;

    const clientId = useAppStore.getState().clientId;
    const relay = new RelayClient(ws, clientId);
    relayRef.current = relay;
    setRuntimeRefs({ wsManagerRef: ws, relayClientRef: relay });

    const timers = createPhaseMachineTimers();
    timersRef.current = timers;

    const unsubStatus = ws.onStatusChange((connected, status) => {
      handleWsStatusChange(
        connected,
        timersRef.current!,
        relayRef.current!,
        status?.willReconnect ?? true,
      );
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
    // Session 生命周期 dispatcher: session_list / session_status / agent_status → session-store。
    // request-scoped session_history_response 由对应 loader 独占处理。
    const unregisterSession = registerSessionDispatcher();
    // 资源 dispatcher: command_list_push / file_tree_push → command-store / file-store。
    // dir_list_response 由发起请求的 FilePathPicker 接管响应和缓存。
    const unregisterResource = registerResourceDispatcher();
    // 网页和设备预览共享同一条按 Relay binding 隔离的事件分发链路。
    const unregisterPreview = registerPreviewDispatcher();

    const reconnectLoop = createRelayReconnectLoop((signal) => reconnectRelayClient(signal));
    activeRelayReconnectLoop = reconnectLoop;
    reconnectLoop.start();

    return () => {
      reconnectLoop.stop();
      if (activeRelayReconnectLoop === reconnectLoop) activeRelayReconnectLoop = null;
      // Invalidate an in-flight manual preflight before tearing down its WebSocket runtime. A late
      // successful /health response must not reconnect a socket whose handlers were just removed.
      if (wsManagerRef === ws) {
        relayReconnectGeneration += 1;
        activeRelayReconnectController?.abort(
          new DOMException("Relay runtime disposed", "AbortError"),
        );
        activeRelayReconnectController = null;
      }
      unsubStatus();
      unsubRelay();
      unregisterChat();
      unregisterSession();
      unregisterResource();
      unregisterPreview();
      previewController.dispose();
      disposePhaseMachineTimers(timers);
      ws.close();
      if (wsManagerRef === ws) {
        setRuntimeRefs({ wsManagerRef: null, relayClientRef: null });
      }
    };
  }, []);
}
