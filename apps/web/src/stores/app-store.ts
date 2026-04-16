// 应用级状态管理：连接状态、选中代理、客户端标识、AppPhase 状态机
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ProxyInfo } from "@cc-anywhere/shared";

export type AppPhase =
  | "connecting"
  | "registering"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting";

interface AppStoreState {
  phase: AppPhase;
  phaseBeforeDisconnect: AppPhase | null;
  connected: boolean;
  proxyOnline: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  proxies: ProxyInfo[];
  clientId: string;
  relayUrl: string;

  setConnected: (connected: boolean) => void;
  setProxy: (proxyId: string | null, proxyName: string | null) => void;
  setProxyOnline: (online: boolean) => void;
  setRelayUrl: (url: string) => void;
  setPhase: (phase: AppPhase) => void;
  setProxies: (proxies: ProxyInfo[]) => void;
  transitionToPhase: (next: AppPhase) => void;
}

function loadClientId(): string {
  const stored = localStorage.getItem("cc_clientId");
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  localStorage.setItem("cc_clientId", id);
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
      clientId: loadClientId(),
      relayUrl: "",

      setConnected: (connected) => set({ connected }),
      setProxy: (proxyId, proxyName) =>
        set({ selectedProxyId: proxyId, selectedProxyName: proxyName }),
      setProxyOnline: (online) => set({ proxyOnline: online }),
      setRelayUrl: (url) => set({ relayUrl: url }),
      setPhase: (phase) => {
        const phaseBeforeDisconnect =
          phase === "reconnecting"
            ? get().phase
            : get().phaseBeforeDisconnect;
        set({ phase, phaseBeforeDisconnect });
      },
      setProxies: (proxies) => set({ proxies }),
      transitionToPhase: (next) => {
        const prev = get().phase;
        cleanStorageForPhaseTransition(prev, next);
        const phaseBeforeDisconnect =
          next === "reconnecting" ? prev : get().phaseBeforeDisconnect;
        set({ phase: next, phaseBeforeDisconnect });
      },
    }),
    { name: "app-store" },
  ),
);
