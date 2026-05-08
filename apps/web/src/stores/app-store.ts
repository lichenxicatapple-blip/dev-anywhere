// 应用级状态管理：连接状态、选中代理、客户端标识、AppPhase 状态机
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ProxyInfo } from "@dev-anywhere/shared";

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
  ptyFontSize: number;
  ptyFitRequestId: number;
  sidebarCollapsed: boolean;
  // 启动早期产生的通知先进入队列，等通知容器就绪后再展示。
  pendingToast: PendingToast | null;

  setConnected: (connected: boolean) => void;
  setProxy: (proxyId: string | null, proxyName: string | null) => void;
  setProxyOnline: (online: boolean) => void;
  setRelayUrl: (url: string) => void;
  setPhase: (phase: AppPhase) => void;
  setProxies: (proxies: ProxyInfo[]) => void;
  resetProxyListLoaded: () => void;
  setPtyFontSize: (fontSize: number) => void;
  adjustPtyFontSize: (delta: number) => void;
  resetPtyFontSize: () => void;
  requestPtyFit: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
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

const DEFAULT_PTY_FONT_SIZE = 14;
export const MIN_PTY_FONT_SIZE = 8;
export const MAX_PTY_FONT_SIZE = 24;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "dev_anywhere_sidebarCollapsed";

function clampPtyFontSize(value: number): number {
  return Math.max(MIN_PTY_FONT_SIZE, Math.min(MAX_PTY_FONT_SIZE, Math.round(value)));
}

function loadPtyFontSize(): number {
  const stored = Number(localStorage.getItem("cc_ptyFontSize"));
  return Number.isFinite(stored) ? clampPtyFontSize(stored) : DEFAULT_PTY_FONT_SIZE;
}

function loadSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
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
      ptyFontSize: loadPtyFontSize(),
      ptyFitRequestId: 0,
      sidebarCollapsed: loadSidebarCollapsed(),
      pendingToast: null,

      setConnected: (connected) => set({ connected }),
      setPendingToast: (toast) => set({ pendingToast: toast }),
      setProxy: (proxyId, proxyName) =>
        set({ selectedProxyId: proxyId, selectedProxyName: proxyName }),
      setProxyOnline: (online) => set({ proxyOnline: online }),
      setRelayUrl: (url) => set({ relayUrl: url }),
      setPtyFontSize: (fontSize) => {
        const next = clampPtyFontSize(fontSize);
        localStorage.setItem("cc_ptyFontSize", String(next));
        set({ ptyFontSize: next });
      },
      adjustPtyFontSize: (delta) => {
        const next = clampPtyFontSize(get().ptyFontSize + delta);
        localStorage.setItem("cc_ptyFontSize", String(next));
        set({ ptyFontSize: next });
      },
      resetPtyFontSize: () => {
        localStorage.setItem("cc_ptyFontSize", String(DEFAULT_PTY_FONT_SIZE));
        set({ ptyFontSize: DEFAULT_PTY_FONT_SIZE });
      },
      requestPtyFit: () => {
        set({ ptyFitRequestId: get().ptyFitRequestId + 1 });
      },
      setSidebarCollapsed: (collapsed) => {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
        set({ sidebarCollapsed: collapsed });
      },
      toggleSidebarCollapsed: () => {
        const next = !get().sidebarCollapsed;
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
        set({ sidebarCollapsed: next });
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
