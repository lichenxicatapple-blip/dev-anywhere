// App 入口：初始化 WebSocket 连接和 RelayClient，管理应用生命周期
import { PropsWithChildren, useEffect, useReducer, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { WebSocketManager } from "@/services/websocket";
import { RelayClient } from "@/services/relay-client";
import {
  AppProvider,
  AppDispatchProvider,
  appReducer,
  initialAppState,
} from "@/stores/app-store";
import { RelayClientProvider } from "@/stores/relay-store";
import "./app.css";

const DEFAULT_RELAY_URL = "ws://localhost:3000/client";

function App({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const wsRef = useRef<WebSocketManager | null>(null);
  const [relayClient, setRelayClient] = useState<RelayClient | null>(null);

  useEffect(() => {
    const relayUrl = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
    dispatch({ type: "SET_RELAY_URL", url: relayUrl });

    const ws = new WebSocketManager();
    wsRef.current = ws;

    ws.onStatusChange((connected) => {
      dispatch({ type: "SET_CONNECTED", connected });
    });

    const relay = new RelayClient(ws, state.clientId);
    setRelayClient(relay);

    ws.onStatusChange((connected) => {
      if (connected) {
        relay.register();
      }
    });

    ws.connect(relayUrl);

    return () => {
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
          {children}
        </AppDispatchProvider>
      </AppProvider>
    </RelayClientProvider>
  );
}

export default App;
