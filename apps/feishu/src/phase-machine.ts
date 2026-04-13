// 状态机事件处理，从 app.tsx useEffect 中提取以支持单元测试
import type { ProxyInfo } from "@cc-anywhere/shared";
import type { AppState, AppPhase, AppAction } from "@/stores/app-store";
import { transitionToPhase } from "@/stores/app-store";
import { resolveColdStart } from "@/pages/proxy-select/cold-start";

export interface Timers {
  proxyLost: ReturnType<typeof setTimeout> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  coldStartDone: boolean;
}

export interface PhaseNav {
  reLaunch(url: string): void;
  navigateTo(url: string): void;
  showToast(title: string): void;
  getStorageSync(key: string): string;
}

export interface PhaseRelay {
  register(): void;
  listProxies(): void;
  selectProxy(proxyId: string): Promise<{ success: boolean; proxyId?: string; error?: string }>;
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
    relay.listProxies();
    // 重连后恢复 proxy 绑定，否则 relay 端 boundProxyId 丢失，
    // 后续控制消息会被拒绝（NOT_BOUND）
    if (s.selectedProxyId) {
      void relay.selectProxy(s.selectedProxyId);
    }
    if (s.phase === "connecting") {
      dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
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
        transitionToPhase(getState().phase, "connecting", dispatch);
        nav.reLaunch("/pages/proxy-select/index");
      }, 10000);
    }
  }
}

export function handleRelayMessage(
  msg: Record<string, unknown>,
  getState: () => AppState,
  dispatch: Dispatch,
  timers: Timers,
  relay: PhaseRelay,
  nav: PhaseNav,
): void {
  const s = getState();

  if (msg.type === "proxy_offline" && msg.proxyId === s.selectedProxyId) {
    dispatch({ type: "SET_PROXY_ONLINE", online: false });
    dispatch({ type: "SET_PHASE", phase: "proxy_lost" });
    nav.showToast("Proxy disconnected");
    timers.proxyLost = setTimeout(() => {
      timers.proxyLost = null;
      transitionToPhase(getState().phase, "proxy_selecting", dispatch);
      nav.reLaunch("/pages/proxy-select/index");
    }, 1500);
  }

  if (msg.type === "proxy_online" && msg.proxyId === s.selectedProxyId) {
    if (timers.proxyLost) {
      clearTimeout(timers.proxyLost);
      timers.proxyLost = null;
      dispatch({ type: "SET_PHASE", phase: s.phaseBeforeDisconnect ?? "session_browsing" });
    }
    dispatch({ type: "SET_PROXY_ONLINE", online: true });
    nav.showToast("Proxy reconnected");
  }

  if (msg.type === "proxy_list_response") {
    const proxies = msg.proxies as ProxyInfo[];

    if (!timers.coldStartDone && s.phase === "proxy_selecting") {
      timers.coldStartDone = true;
      const result = resolveColdStart(
        nav.getStorageSync("cc_proxyId"),
        nav.getStorageSync("cc_sessionId"),
        proxies,
        nav.getStorageSync("cc_sessionMode"),
      );
      if (result) {
        dispatch({ type: "SET_PROXY", proxyId: result.proxy.proxyId, proxyName: result.proxy.name || null });
        dispatch({ type: "SET_PROXY_ONLINE", online: true });
        void relay.selectProxy(result.proxy.proxyId);
        const targetPhase: AppPhase = result.url.includes("chat") ? "chatting" : "session_browsing";
        dispatch({ type: "SET_PHASE", phase: targetPhase });
        nav.navigateTo(result.url);
        return;
      }
    }

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
