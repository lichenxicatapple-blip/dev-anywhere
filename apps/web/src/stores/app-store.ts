// 应用级状态管理：连接状态、选中代理、客户端标识、AppPhase 状态机
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ProxyInfo } from "@cc-anywhere/shared";

type AppPhase =
  | "connecting"
  | "registering"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting";

interface PendingToast {
  kind: "error" | "info" | "success";
  message: string;
}

interface AppStoreState {
  phase: AppPhase;
  phaseBeforeDisconnect: AppPhase | null;
  connected: boolean;
  proxyOnline: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  proxies: ProxyInfo[];
  // 首次 proxy_list_response 到达前为 false; WS 断开回退 false, 区分"加载中"与"真的没有 proxy"
  proxyListLoaded: boolean;
  clientId: string;
  relayUrl: string;
  // PTY 终端 xterm 字号自适应容器：缩字号铺满视口 vs 保 14 字号允许滚动
  ptyAutoscale: boolean;
  // 模块级代码 (phase-machine) 想弹 toast 但 Sonner 可能还没订阅就绪时, 经由此处暂存, 等 AppShell mount 后消费
  pendingToast: PendingToast | null;

  setConnected: (connected: boolean) => void;
  setProxy: (proxyId: string | null, proxyName: string | null) => void;
  setProxyOnline: (online: boolean) => void;
  setRelayUrl: (url: string) => void;
  setPhase: (phase: AppPhase) => void;
  setProxies: (proxies: ProxyInfo[]) => void;
  resetProxyListLoaded: () => void;
  setPtyAutoscale: (enabled: boolean) => void;
  setPendingToast: (toast: PendingToast | null) => void;
  transitionToPhase: (next: AppPhase) => void;
}

// clientId 必须 per-tab 独立，否则同 origin 多 tab 共享同 id 时，后连的
// client_register 会在 relay 侧覆盖 binding.ws，导致 broadcast 只到最后一个 tab
function loadClientId(): string {
  const stored = sessionStorage.getItem("cc_clientId");
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  sessionStorage.setItem("cc_clientId", id);
  return id;
}

function cleanStorageForPhaseTransition(prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    localStorage.removeItem("cc_proxyId");
    localStorage.removeItem("cc_sessionId");
  }
  if (next === "session_browsing" && prev === "chatting") {
    localStorage.removeItem("cc_sessionId");
  }
}

export const useAppStore = create<AppStoreState>()(
  devtools(
    (set, get) => ({
      phase: "connecting",
      phaseBeforeDisconnect: null,
      connected: false,
      proxyOnline: false,
      selectedProxyId: null,
      selectedProxyName: null,
      proxies: [],
      proxyListLoaded: false,
      clientId: loadClientId(),
      relayUrl: "",
      ptyAutoscale: localStorage.getItem("cc_ptyAutoscale") === "on",
      pendingToast: null,

      setConnected: (connected) => set({ connected }),
      setPendingToast: (toast) => set({ pendingToast: toast }),
      setProxy: (proxyId, proxyName) =>
        set({ selectedProxyId: proxyId, selectedProxyName: proxyName }),
      setProxyOnline: (online) => set({ proxyOnline: online }),
      setRelayUrl: (url) => set({ relayUrl: url }),
      setPtyAutoscale: (enabled) => {
        localStorage.setItem("cc_ptyAutoscale", enabled ? "on" : "off");
        set({ ptyAutoscale: enabled });
      },
      setPhase: (phase) => {
        const phaseBeforeDisconnect =
          phase === "reconnecting" ? get().phase : get().phaseBeforeDisconnect;
        set({ phase, phaseBeforeDisconnect });
      },
      setProxies: (proxies) => set({ proxies, proxyListLoaded: true }),
      resetProxyListLoaded: () => set({ proxyListLoaded: false }),
      transitionToPhase: (next) => {
        const prev = get().phase;
        cleanStorageForPhaseTransition(prev, next);
        const phaseBeforeDisconnect = next === "reconnecting" ? prev : get().phaseBeforeDisconnect;
        set({ phase: next, phaseBeforeDisconnect });
      },
    }),
    { name: "app-store" },
  ),
);
