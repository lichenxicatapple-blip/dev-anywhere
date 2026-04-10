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
} from "@/stores/app-store";
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
  const wsRef = useRef<WebSocketManager | null>(null);
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
      if (connected) {
        relay.register();
        // 重连后主动请求 proxy 列表，通过 proxy_list_response 恢复 proxyOnline 状态
        relay.listProxies();
      } else {
        // relay 断开后 proxy 状态未知，重置为离线，重连后通过 proxy_list_response 恢复
        dispatch({ type: "SET_PROXY_ONLINE", online: false });
      }
    });

    ws.connect(relayUrl);

    // 全局监听 proxy 上下线状态，主动通知用户
    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as Record<string, unknown>;
      if (ctrl.type === "proxy_offline" && ctrl.proxyId === state.selectedProxyId) {
        dispatch({ type: "SET_PROXY_ONLINE", online: false });
        Taro.showToast({ title: "Proxy disconnected", icon: "none", duration: 2000 });
      }
      if (ctrl.type === "proxy_online" && ctrl.proxyId === state.selectedProxyId) {
        dispatch({ type: "SET_PROXY_ONLINE", online: true });
        Taro.showToast({ title: "Proxy reconnected", icon: "none", duration: 2000 });
      }
      // 收到 proxy 列表时，检查当前选中的 proxy 是否在线
      if (ctrl.type === "proxy_list_response" && state.selectedProxyId) {
        const proxies = ctrl.proxies as ProxyInfo[];
        const selected = proxies.find((p) => p.proxyId === state.selectedProxyId);
        dispatch({ type: "SET_PROXY_ONLINE", online: selected?.online ?? false });
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
