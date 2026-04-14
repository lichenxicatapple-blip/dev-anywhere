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
import {
  SessionProvider,
  SessionDispatchProvider,
  sessionReducer,
  initialSessionState,
} from "@/stores/session-store";
import {
  FileProvider,
  FileDispatchProvider,
  fileReducer,
  initialFileState,
} from "@/stores/file-store";
import {
  CommandProvider,
  CommandDispatchProvider,
  commandReducer,
  initialCommandState,
} from "@/stores/command-store";
import { handleWsStatusChange, handleRelayMessage } from "@/phase-machine";
import type { Timers } from "@/phase-machine";
import "./app.css";

declare const RELAY_URL: string;
const DEFAULT_RELAY_URL = RELAY_URL;

// 从 WebSocket URL 推导 HTTP URL，用于加载字体等静态资源
function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/(proxy|client)$/, "");
}

// 动态注入字体 CSS link 标签
function loadFontCSS(relayUrl: string): void {
  const base = relayHttpUrl(relayUrl);
  const href = `${base}/fonts/sarasa-fixed-sc/result.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function App({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [sessionState, sessionDispatch] = useReducer(sessionReducer, initialSessionState);
  const [fileState, fileDispatch] = useReducer(fileReducer, initialFileState);
  const [commandState, commandDispatch] = useReducer(commandReducer, initialCommandState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const wsRef = useRef<WebSocketManager | null>(null);
  const timersRef = useRef<Timers>({ reconnect: null, coldStartDone: false });
  const [relayClient, setRelayClient] = useState<RelayClient | null>(null);

  useEffect(() => {
    const relayUrl = Taro.getStorageSync("cc_relayUrl") as string || DEFAULT_RELAY_URL;
    dispatch({ type: "SET_RELAY_URL", url: relayUrl });
    loadFontCSS(relayUrl);

    const ws = new WebSocketManager();
    wsRef.current = ws;

    const relay = new RelayClient(ws, state.clientId);
    setRelayClient(relay);

    const getState = () => stateRef.current;
    const nav = {
      reLaunch: (url: string) => Taro.reLaunch({ url }),
      navigateTo: (url: string) => Taro.navigateTo({ url }),
      showToast: (title: string) => Taro.showToast({ title, icon: "none", duration: 1500 }),
      getStorageSync: (key: string) => Taro.getStorageSync(key) as string,
      removeStorageSync: (key: string) => Taro.removeStorageSync(key),
      getCurrentPath: () => {
        const pages = Taro.getCurrentPages();
        return pages.length > 0 ? pages[pages.length - 1].route || "" : "";
      },
    };

    ws.onStatusChange((connected) => {
      handleWsStatusChange(connected, getState, dispatch, timersRef.current, relay, nav);
    });

    ws.connect(relayUrl);

    const unsub = relay.onMessage((msg) => {
      void handleRelayMessage(msg as Record<string, unknown>, getState, dispatch, timersRef.current, relay, nav);
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
              <FileProvider value={fileState}>
                <FileDispatchProvider value={fileDispatch}>
                  <CommandProvider value={commandState}>
                    <CommandDispatchProvider value={commandDispatch}>
                      {children}
                    </CommandDispatchProvider>
                  </CommandProvider>
                </FileDispatchProvider>
              </FileProvider>
            </SessionDispatchProvider>
          </SessionProvider>
        </AppDispatchProvider>
      </AppProvider>
    </RelayClientProvider>
  );
}

export default App;
