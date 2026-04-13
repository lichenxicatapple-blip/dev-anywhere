// 状态机事件处理，从 app.tsx useEffect 中提取以支持单元测试
import type { ProxyInfo } from "@cc-anywhere/shared";
import type { AppState, AppAction } from "@/stores/app-store";
import { transitionToPhase } from "@/stores/app-store";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";

export interface Timers {
  reconnect: ReturnType<typeof setTimeout> | null;
  coldStartDone: boolean;
}

export interface PhaseNav {
  reLaunch(url: string): void;
  navigateTo(url: string): void;
  showToast(title: string): void;
  getStorageSync(key: string): string;
  getCurrentPath(): string;
}

export interface PhaseRelay {
  register(): void;
  listProxies(): void;
  selectProxy(proxyId: string): Promise<{ success: boolean; proxyId?: string; error?: string }>;
  requestProxyList(): Promise<Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>>;
  getBoundProxyId(): string | null;
}

type Dispatch = React.Dispatch<AppAction>;

export function handleWsStatusChange(
  connected: boolean,
  getState: () => AppState,
  dispatch: Dispatch,
  timers: Timers,
  relay: PhaseRelay,
  nav: PhaseNav,
): void {
  dispatch({ type: "SET_CONNECTED", connected });
  const s = getState();
  if (connected) {
    relay.register();

    if (s.phase === "connecting") {
      dispatch({ type: "SET_PHASE", phase: "registering" });
    }

    if (s.phase === "reconnecting") {
      relay.listProxies();
      if (s.selectedProxyId) {
        void relay.selectProxy(s.selectedProxyId);
      }
    }

    if (timers.reconnect) {
      clearTimeout(timers.reconnect);
      timers.reconnect = null;
    }
  } else {
    dispatch({ type: "SET_PROXY_ONLINE", online: false });
    if (s.phase !== "connecting") {
      dispatch({ type: "SET_PHASE", phase: "reconnecting" });
      timers.reconnect = setTimeout(() => {
        timers.reconnect = null;
        timers.coldStartDone = false;
        dispatch({ type: "SET_PROXIES", proxies: [] });
        transitionToPhase(getState().phase, "connecting", dispatch);
        nav.reLaunch("/pages/proxy-select/index");
      }, 10000);
    }
  }
}

export async function handleRelayMessage(
  msg: Record<string, unknown>,
  getState: () => AppState,
  dispatch: Dispatch,
  timers: Timers,
  relay: PhaseRelay,
  nav: PhaseNav,
): Promise<void> {
  const s = getState();

  // client_register_response: 从 registering 转入 proxy_selecting
  if (msg.type === "client_register_response") {
    if (s.phase === "registering") {
      relay.listProxies();
      dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
    }
    return;
  }

  // proxy_offline: 更新标记并刷新列表
  if (msg.type === "proxy_offline") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      dispatch({ type: "SET_PROXY_ONLINE", online: false });
      nav.showToast("Proxy offline");
    }
    return;
  }

  // proxy_online: 更新标记并刷新列表
  if (msg.type === "proxy_online") {
    relay.listProxies();
    if (msg.proxyId === s.selectedProxyId) {
      dispatch({ type: "SET_PROXY_ONLINE", online: true });
      nav.showToast("Proxy reconnected");
    }
    return;
  }

  if (msg.type === "proxy_list_response") {
    const proxies = msg.proxies as ProxyInfo[];
    dispatch({ type: "SET_PROXIES", proxies });

    // 冷启动：首次 proxy_list_response 时在 proxy_selecting 阶段执行
    if (!timers.coldStartDone && s.phase === "proxy_selecting") {
      timers.coldStartDone = true;
      const savedProxyId = nav.getStorageSync("cc_proxyId");
      console.log("[cold-start]", { savedProxyId, proxyCount: proxies.length, boundProxyId: relay.getBoundProxyId() });
      if (!savedProxyId) {
        // no-op, coldStartDone already true
      } else {
        const result = await ensureBinding(relay as unknown as RelayClient, { proxyId: savedProxyId });
        console.log("[cold-start] binding result:", result);
        if (!isBindingError(result)) {
          const proxyInfo = proxies.find((p) => p.proxyId === savedProxyId);
          dispatch({ type: "SET_PROXY", proxyId: savedProxyId, proxyName: proxyInfo?.name || null });
          dispatch({ type: "SET_PROXY_ONLINE", online: true });
          const savedSessionId = nav.getStorageSync("cc_sessionId");
          const currentPath = nav.getCurrentPath();
          if (savedSessionId) {
            const mode = nav.getStorageSync("cc_sessionMode") || "json";
            dispatch({ type: "SET_PHASE", phase: "chatting" });
            if (!currentPath.includes("/pages/chat/index")) {
              nav.navigateTo(`/pages/chat/index?sessionId=${savedSessionId}&mode=${mode}`);
            }
          } else {
            dispatch({ type: "SET_PHASE", phase: "session_browsing" });
          }
          return;
        }
        timers.coldStartDone = false;
      }
    }

    // 重连验证
    if (s.selectedProxyId) {
      const selected = proxies.find((p) => p.proxyId === s.selectedProxyId);
      dispatch({ type: "SET_PROXY_ONLINE", online: selected?.online ?? false });

      if (s.phase === "reconnecting") {
        if (selected?.online) {
          transitionToPhase(s.phase, s.phaseBeforeDisconnect ?? "session_browsing", dispatch);
        } else {
          transitionToPhase(s.phase, "proxy_selecting", dispatch);
          nav.reLaunch("/pages/proxy-select/index");
        }
      }
    }
  }
}
