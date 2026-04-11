// App 入口：初始化 WebSocket 连接和 RelayClient，管理应用生命周期
import { PropsWithChildren, useEffect, useReducer, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import type { ProxyInfo } from "@cc-anywhere/shared";
import { WebSocketManager } from "@/services/websocket";
import { RelayClient } from "@/services/relay-client";
import {
  AppProvider,
  AppDispatchProvider,
  appReducer,
  initialAppState,
  transitionToPhase,
} from "@/stores/app-store";
import type { AppPhase } from "@/stores/app-store";
import { resolveColdStart } from "@/pages/proxy-select/cold-start";
import { RelayClientProvider } from "@/stores/relay-store";
import {
  SessionProvider,
  SessionDispatchProvider,
  sessionReducer,
  initialSessionState,
} from "@/stores/session-store";
import "./app.css";

declare const RELAY_URL: string;
const DEFAULT_RELAY_URL = RELAY_URL;

function App({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [sessionState, sessionDispatch] = useReducer(sessionReducer, initialSessionState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const wsRef = useRef<WebSocketManager | null>(null);
  const proxyLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coldStartDoneRef = useRef(false);
  const [relayClient, setRelayClient] = useState<RelayClient | null>(null);

  useEffect(() => {
    const relayUrl = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
    dispatch({ type: "SET_RELAY_URL", url: relayUrl });

    const ws = new WebSocketManager();
    wsRef.current = ws;

    const relay = new RelayClient(ws, state.clientId);
    setRelayClient(relay);

    ws.onStatusChange((connected) => {
      dispatch({ type: "SET_CONNECTED", connected });
      const s = stateRef.current;
      if (connected) {
        relay.register();
        relay.listProxies();
        if (s.phase === "connecting") {
          dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
        }
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      } else {
        dispatch({ type: "SET_PROXY_ONLINE", online: false });
        if (s.phase !== "connecting") {
          dispatch({ type: "SET_PHASE", phase: "reconnecting" });
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            transitionToPhase(stateRef.current.phase, "connecting", dispatch);
            Taro.reLaunch({ url: "/pages/proxy-select/index" });
          }, 10000);
        }
      }
    });

    ws.connect(relayUrl);

    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as Record<string, unknown>;
      const s = stateRef.current;

      if (ctrl.type === "proxy_offline" && ctrl.proxyId === s.selectedProxyId) {
        dispatch({ type: "SET_PROXY_ONLINE", online: false });
        dispatch({ type: "SET_PHASE", phase: "proxy_lost" });
        Taro.showToast({ title: "Proxy disconnected", icon: "none", duration: 1500 });
        proxyLostTimerRef.current = setTimeout(() => {
          proxyLostTimerRef.current = null;
          transitionToPhase(stateRef.current.phase, "proxy_selecting", dispatch);
          Taro.reLaunch({ url: "/pages/proxy-select/index" });
        }, 1500);
      }

      if (ctrl.type === "proxy_online" && ctrl.proxyId === s.selectedProxyId) {
        if (proxyLostTimerRef.current) {
          clearTimeout(proxyLostTimerRef.current);
          proxyLostTimerRef.current = null;
          dispatch({ type: "SET_PHASE", phase: s.phaseBeforeDisconnect ?? "session_browsing" });
        }
        dispatch({ type: "SET_PROXY_ONLINE", online: true });
        Taro.showToast({ title: "Proxy reconnected", icon: "none", duration: 1500 });
      }

      if (ctrl.type === "proxy_list_response") {
        const proxies = ctrl.proxies as ProxyInfo[];

        // 冷启动：仅在首次 proxy_list_response 且处于 proxy_selecting 时触发
        if (!coldStartDoneRef.current && s.phase === "proxy_selecting") {
          coldStartDoneRef.current = true;
          const result = resolveColdStart(
            Taro.getStorageSync("cc_proxyId") as string,
            Taro.getStorageSync("cc_sessionId") as string,
            proxies,
          );
          if (result) {
            dispatch({ type: "SET_PROXY", proxyId: result.proxy.proxyId, proxyName: result.proxy.name || null });
            dispatch({ type: "SET_PROXY_ONLINE", online: true });
            relay.selectProxy(result.proxy.proxyId);
            const targetPhase: AppPhase = result.url.includes("chat") ? "chatting" : "session_browsing";
            dispatch({ type: "SET_PHASE", phase: targetPhase });
            Taro.navigateTo({ url: result.url });
            return;
          }
        }

        // 正常处理：更新 proxy 在线状态
        if (s.selectedProxyId) {
          const selected = proxies.find((p) => p.proxyId === s.selectedProxyId);
          dispatch({ type: "SET_PROXY_ONLINE", online: selected?.online ?? false });

          // 重连验证
          if (s.phase === "reconnecting") {
            if (selected?.online) {
              transitionToPhase(s.phase, s.phaseBeforeDisconnect ?? "session_browsing", dispatch);
            } else {
              transitionToPhase(s.phase, "proxy_selecting", dispatch);
              Taro.reLaunch({ url: "/pages/proxy-select/index" });
            }
          }
        }
      }
    });

    return () => {
      unsub();
      ws.close();
    };
  }, []);

  // onShow: 前台恢复时检查 WebSocket 状态，必要时重连
  Taro.useDidShow(() => {
    const ws = wsRef.current;
    if (ws && !ws.isConnected()) {
      const url = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
      ws.connect(url);
    }
  });

  return (
    <RelayClientProvider value={relayClient}>
      <AppProvider value={state}>
        <AppDispatchProvider value={dispatch}>
          <SessionProvider value={sessionState}>
            <SessionDispatchProvider value={sessionDispatch}>
              {children}
            </SessionDispatchProvider>
          </SessionProvider>
        </AppDispatchProvider>
      </AppProvider>
    </RelayClientProvider>
  );
}

export default App;
