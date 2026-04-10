// Proxy 选择页：深色终端主题，品牌打字机 header，proxy 列表，D-02 冷启动自动导航
import { useState, useEffect, useCallback } from "react";
import { View, Text } from "@tarojs/components";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import type { ProxyInfo, RelayControlMessage } from "@cc-anywhere/shared";
import { useRelayClient } from "@/stores/relay-store";
import { useAppState, useAppDispatch } from "@/stores/app-store";
import { useScreenSize } from "@/hooks/use-screen-size";
import { Typewriter } from "@/components/typewriter";
import { ProxyListItem } from "@/components/proxy-list-item";
import { EmptyState } from "@/components/empty-state";
import "./index.css";

const BRAND_TEXTS = ["CC Anywhere", "/unlimited @anytime"];

export default function ProxySelect() {
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dots, setDots] = useState("");
  const relay = useRelayClient();
  const appState = useAppState();
  const appDispatch = useAppDispatch();
  const screen = useScreenSize();

  // 连接中省略号动画
  useEffect(() => {
    if (appState.connected) return;
    const timer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 500);
    return () => clearInterval(timer);
  }, [appState.connected]);

  // 请求 proxy 列表
  const fetchProxies = useCallback(() => {
    if (relay) {
      relay.listProxies();
    }
  }, [relay]);

  // 监听 proxy_list_response
  useEffect(() => {
    if (!relay) return;

    const unsub = relay.onMessage((msg) => {
      const ctrl = msg as RelayControlMessage;
      if (ctrl.type === "proxy_list_response") {
        setProxies(ctrl.proxies);
        setLoaded(true);

        // D-02: 冷启动自动导航
        const savedProxyId = Taro.getStorageSync("cc_proxyId") as string;
        const savedSessionId = Taro.getStorageSync("cc_sessionId") as string;
        if (savedProxyId && savedSessionId) {
          const onlineProxy = ctrl.proxies.find((p) => p.proxyId === savedProxyId && p.online);
          if (onlineProxy) {
            appDispatch({
              type: "SET_PROXY",
              proxyId: savedProxyId,
              proxyName: onlineProxy.name || null,
            });
            appDispatch({ type: "SET_PROXY_ONLINE", online: true });
            relay.selectProxy(savedProxyId);
            Taro.navigateTo({ url: "/pages/chat/index" });
            return;
          }
        }
      }
    });

    // 连接建立后才发请求，避免在 WebSocket 未就绪时发送被丢弃
    if (appState.connected) {
      fetchProxies();
    }
    return unsub;
  }, [relay, appState.connected, appDispatch, fetchProxies]);

  // 下拉刷新
  usePullDownRefresh(() => {
    fetchProxies();
    setTimeout(() => {
      Taro.stopPullDownRefresh();
    }, 500);
  });

  // 选择 proxy
  const handleSelect = useCallback(
    (proxy: ProxyInfo) => {
      Taro.setStorageSync("cc_proxyId", proxy.proxyId);
      appDispatch({
        type: "SET_PROXY",
        proxyId: proxy.proxyId,
        proxyName: proxy.name || null,
      });
      appDispatch({ type: "SET_PROXY_ONLINE", online: true });
      if (relay) {
        relay.selectProxy(proxy.proxyId);
      }
      Taro.navigateTo({ url: "/pages/session-list/index" });
    },
    [relay, appDispatch],
  );

  const hasOnlineProxy = proxies.length > 0;

  return (
    <View className={`proxy-page ${screen.className}`}>
      <View className="proxy-content">
        <View className="brand-area">
          <Typewriter texts={BRAND_TEXTS} />
        </View>

        <Text className="proxy-section-title">Proxies</Text>
        <View className="proxy-list">
          {!appState.connected && (
            <View className="connecting-state">
              <View className="connecting-title-row">
                <Text className="connecting-title">Connecting to Relay Server</Text>
                <Text className="connecting-dots">{dots}</Text>
              </View>
            </View>
          )}
          {appState.connected && loaded && !hasOnlineProxy && (
            <EmptyState
              title="No Proxy Online"
              subtitle="Run cc-anywhere on your computer to connect"
            />
          )}
          {proxies.map((proxy) => (
            <ProxyListItem
              key={proxy.proxyId}
              proxy={proxy}
              online={proxy.online}
              onSelect={() => handleSelect(proxy)}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
