// 应用级状态管理：连接状态、选中代理、客户端标识、AppPhase 状态机
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ProxyInfo } from "@dev-anywhere/shared";
import {
  DEFAULT_CHAT_CONTENT_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
} from "@/lib/chat-font-size";
import {
  readStorageValue,
  removeStorageValue,
  STORAGE_KEYS,
  writeStorageValue,
} from "@/lib/storage-keys";
import type { RelayClientAuthIssue } from "@/lib/relay-client-auth";

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
  relayClientAuthIssue: RelayClientAuthIssue | null;
  ptyFontSize: number;
  chatContentFontSize: number;
  sidebarCollapsed: boolean;
  // 启动早期产生的通知先进入队列，等通知容器就绪后再展示。
  pendingToast: PendingToast | null;

  setConnected: (connected: boolean) => void;
  setProxy: (proxyId: string | null, proxyName: string | null) => void;
  setProxyOnline: (online: boolean) => void;
  setRelayUrl: (url: string) => void;
  setRelayClientAuthIssue: (issue: RelayClientAuthIssue | null) => void;
  setPhase: (phase: AppPhase) => void;
  setProxies: (proxies: ProxyInfo[]) => void;
  resetProxyListLoaded: () => void;
  setPtyFontSize: (fontSize: number) => void;
  adjustPtyFontSize: (delta: number) => void;
  resetPtyFontSize: () => void;
  setChatContentFontSize: (fontSize: number) => void;
  adjustChatContentFontSize: (delta: number) => void;
  resetChatContentFontSize: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setPendingToast: (toast: PendingToast | null) => void;
  transitionToPhase: (next: AppPhase) => void;
}

// clientId 必须 per-tab 独立，否则同 origin 多 tab 共享同 id 时，后连的
// client_register 会在 relay 侧覆盖 binding.ws，导致 broadcast 只到最后一个 tab
function loadClientId(): string {
  const stored = readStorageValue("session", STORAGE_KEYS.clientId);
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  writeStorageValue("session", STORAGE_KEYS.clientId, id);
  return id;
}

function cleanStorageForPhaseTransition(_prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    removeStorageValue("local", STORAGE_KEYS.proxyId);
  }
}

function clampChatFontSize(value: number): number {
  return Math.max(MIN_CHAT_FONT_SIZE, Math.min(MAX_CHAT_FONT_SIZE, Math.round(value)));
}

function loadStoredFontSize(key: string, fallback: number): number {
  const raw = readStorageValue("local", key);
  if (raw === null || raw.trim() === "") return fallback;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampChatFontSize(stored) : fallback;
}

function loadPtyFontSize(): number {
  return loadStoredFontSize(STORAGE_KEYS.ptyFontSize, DEFAULT_TERMINAL_FONT_SIZE);
}

function loadChatContentFontSize(): number {
  return loadStoredFontSize(STORAGE_KEYS.chatContentFontSize, DEFAULT_CHAT_CONTENT_FONT_SIZE);
}

function loadSidebarCollapsed(): boolean {
  return readStorageValue("local", STORAGE_KEYS.sidebarCollapsed) === "1";
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
      relayClientAuthIssue: null,
      ptyFontSize: loadPtyFontSize(),
      chatContentFontSize: loadChatContentFontSize(),
      sidebarCollapsed: loadSidebarCollapsed(),
      pendingToast: null,

      setConnected: (connected) => set({ connected }),
      setPendingToast: (toast) => set({ pendingToast: toast }),
      setProxy: (proxyId, proxyName) =>
        set({ selectedProxyId: proxyId, selectedProxyName: proxyName }),
      setProxyOnline: (online) => set({ proxyOnline: online }),
      setRelayUrl: (url) => set({ relayUrl: url }),
      setRelayClientAuthIssue: (issue) => set({ relayClientAuthIssue: issue }),
      setPtyFontSize: (fontSize) => {
        const next = clampChatFontSize(fontSize);
        writeStorageValue("local", STORAGE_KEYS.ptyFontSize, String(next));
        set({ ptyFontSize: next });
      },
      adjustPtyFontSize: (delta) => {
        const next = clampChatFontSize(get().ptyFontSize + delta);
        writeStorageValue("local", STORAGE_KEYS.ptyFontSize, String(next));
        set({ ptyFontSize: next });
      },
      resetPtyFontSize: () => {
        writeStorageValue("local", STORAGE_KEYS.ptyFontSize, String(DEFAULT_TERMINAL_FONT_SIZE));
        set({ ptyFontSize: DEFAULT_TERMINAL_FONT_SIZE });
      },
      setChatContentFontSize: (fontSize) => {
        const next = clampChatFontSize(fontSize);
        writeStorageValue("local", STORAGE_KEYS.chatContentFontSize, String(next));
        set({ chatContentFontSize: next });
      },
      adjustChatContentFontSize: (delta) => {
        const next = clampChatFontSize(get().chatContentFontSize + delta);
        writeStorageValue("local", STORAGE_KEYS.chatContentFontSize, String(next));
        set({ chatContentFontSize: next });
      },
      resetChatContentFontSize: () => {
        writeStorageValue(
          "local",
          STORAGE_KEYS.chatContentFontSize,
          String(DEFAULT_CHAT_CONTENT_FONT_SIZE),
        );
        set({ chatContentFontSize: DEFAULT_CHAT_CONTENT_FONT_SIZE });
      },
      setSidebarCollapsed: (collapsed) => {
        writeStorageValue("local", STORAGE_KEYS.sidebarCollapsed, collapsed ? "1" : "0");
        set({ sidebarCollapsed: collapsed });
      },
      toggleSidebarCollapsed: () => {
        const next = !get().sidebarCollapsed;
        writeStorageValue("local", STORAGE_KEYS.sidebarCollapsed, next ? "1" : "0");
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
