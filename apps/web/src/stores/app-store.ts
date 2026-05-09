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
  chatContentFontSize: number;
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
  setChatContentFontSize: (fontSize: number) => void;
  adjustChatContentFontSize: (delta: number) => void;
  resetChatContentFontSize: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setPendingToast: (toast: PendingToast | null) => void;
  transitionToPhase: (next: AppPhase) => void;
}

type StorageKind = "local" | "session";

function getStorage(kind: StorageKind): Storage | null {
  try {
    const storage = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

function readStorage(kind: StorageKind, key: string): string | null {
  const storage = getStorage(kind);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: StorageKind, key: string, value: string): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing, tests, or embedded webviews.
  }
}

function removeStorage(kind: StorageKind, key: string): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore transient storage failures; app state remains in memory.
  }
}

// clientId 必须 per-tab 独立，否则同 origin 多 tab 共享同 id 时，后连的
// client_register 会在 relay 侧覆盖 binding.ws，导致 broadcast 只到最后一个 tab
function loadClientId(): string {
  const stored = readStorage("session", "cc_clientId");
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  writeStorage("session", "cc_clientId", id);
  return id;
}

function cleanStorageForPhaseTransition(prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    removeStorage("local", "cc_proxyId");
    removeStorage("local", "cc_sessionId");
  }
  if (next === "session_browsing" && prev === "chatting") {
    removeStorage("local", "cc_sessionId");
  }
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "dev_anywhere_sidebarCollapsed";
const CHAT_CONTENT_FONT_SIZE_STORAGE_KEY = "dev_anywhere_chatContentFontSize";

function clampChatFontSize(value: number): number {
  return Math.max(MIN_CHAT_FONT_SIZE, Math.min(MAX_CHAT_FONT_SIZE, Math.round(value)));
}

function loadStoredFontSize(key: string, fallback: number): number {
  const raw = readStorage("local", key);
  if (raw === null || raw.trim() === "") return fallback;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampChatFontSize(stored) : fallback;
}

function loadPtyFontSize(): number {
  return loadStoredFontSize("cc_ptyFontSize", DEFAULT_TERMINAL_FONT_SIZE);
}

function loadChatContentFontSize(): number {
  return loadStoredFontSize(CHAT_CONTENT_FONT_SIZE_STORAGE_KEY, DEFAULT_CHAT_CONTENT_FONT_SIZE);
}

function loadSidebarCollapsed(): boolean {
  return readStorage("local", SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
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
      chatContentFontSize: loadChatContentFontSize(),
      sidebarCollapsed: loadSidebarCollapsed(),
      pendingToast: null,

      setConnected: (connected) => set({ connected }),
      setPendingToast: (toast) => set({ pendingToast: toast }),
      setProxy: (proxyId, proxyName) =>
        set({ selectedProxyId: proxyId, selectedProxyName: proxyName }),
      setProxyOnline: (online) => set({ proxyOnline: online }),
      setRelayUrl: (url) => set({ relayUrl: url }),
      setPtyFontSize: (fontSize) => {
        const next = clampChatFontSize(fontSize);
        writeStorage("local", "cc_ptyFontSize", String(next));
        set({ ptyFontSize: next });
      },
      adjustPtyFontSize: (delta) => {
        const next = clampChatFontSize(get().ptyFontSize + delta);
        writeStorage("local", "cc_ptyFontSize", String(next));
        set({ ptyFontSize: next });
      },
      resetPtyFontSize: () => {
        writeStorage("local", "cc_ptyFontSize", String(DEFAULT_TERMINAL_FONT_SIZE));
        set({ ptyFontSize: DEFAULT_TERMINAL_FONT_SIZE });
      },
      setChatContentFontSize: (fontSize) => {
        const next = clampChatFontSize(fontSize);
        writeStorage("local", CHAT_CONTENT_FONT_SIZE_STORAGE_KEY, String(next));
        set({ chatContentFontSize: next });
      },
      adjustChatContentFontSize: (delta) => {
        const next = clampChatFontSize(get().chatContentFontSize + delta);
        writeStorage("local", CHAT_CONTENT_FONT_SIZE_STORAGE_KEY, String(next));
        set({ chatContentFontSize: next });
      },
      resetChatContentFontSize: () => {
        writeStorage(
          "local",
          CHAT_CONTENT_FONT_SIZE_STORAGE_KEY,
          String(DEFAULT_CHAT_CONTENT_FONT_SIZE),
        );
        set({ chatContentFontSize: DEFAULT_CHAT_CONTENT_FONT_SIZE });
      },
      setSidebarCollapsed: (collapsed) => {
        writeStorage("local", SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
        set({ sidebarCollapsed: collapsed });
      },
      toggleSidebarCollapsed: () => {
        const next = !get().sidebarCollapsed;
        writeStorage("local", SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
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
