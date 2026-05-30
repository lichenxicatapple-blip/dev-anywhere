import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayClient } from "@/services/relay-client";
import { handleRelayMessage, handleWsStatusChange, type Timers } from "./phase-machine";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";

vi.mock("@/lib/router", () => ({
  router: { navigate: vi.fn() },
}));

const toastError = vi.fn();
vi.mock("@/components/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

function resetAppStore(): void {
  useAppStore.setState({
    phase: "chatting",
    phaseBeforeDisconnect: null,
    connected: true,
    proxyOnline: true,
    selectedProxyId: "proxy-1",
    selectedProxyName: "DEV Mac",
    proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
    proxyListLoaded: true,
    relayClientAuthIssue: null,
    pendingToast: null,
  });
}

describe("phase-machine reconnect timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("keeps one reconnect fallback timer across repeated disconnect notifications", () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    handleWsStatusChange(false, timers, relay);
    const firstTimer = timers.reconnect;

    handleWsStatusChange(false, timers, relay);

    expect(timers.reconnect).toBe(firstTimer);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(useAppStore.getState().phaseBeforeDisconnect).toBe("chatting");

    handleWsStatusChange(true, timers, relay);
    expect(timers.reconnect).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(relay.register).toHaveBeenCalledTimes(1);
    expect(relay.listProxies).toHaveBeenCalledTimes(1);
  });

  it("reselects the current proxy when it returns after a graceful proxy restart", async () => {
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockResolvedValue({
        homePath: "/Users/catli",
        agentCli: {
          claude: { available: true, command: "claude" },
          codex: { available: true, command: "codex" },
        },
      }),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-1" }, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    expect(relay.selectProxy).toHaveBeenCalledWith("proxy-1");
    expect(relay.sendControl).toHaveBeenCalledWith({ type: "session_list" });
    expect(useAppStore.getState().phase).toBe("chatting");
    expect(useAppStore.getState().proxyOnline).toBe(true);
  });
});

describe("phase-machine request failure handling", () => {
  beforeEach(() => {
    resetAppStore();
    toastError.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("surfaces requestProxyInfo failure via toast and does not crash subsequent flow", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockRejectedValue(new Error("relay timeout")),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-1" }, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("无法获取开发机信息");
    });
    // 失败不应阻断后续 phase 推进
    expect(useAppStore.getState().phase).toBe("chatting");
    errSpy.mockRestore();
  });

  it("surfaces requestSessionHistory failure via toast", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockResolvedValue({
        homePath: "/h",
        agentCli: {
          claude: { available: true, command: "c" },
          codex: { available: true, command: "c" },
        },
      }),
      requestSessionHistory: vi.fn().mockRejectedValue(new Error("relay down")),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-1" }, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("无法加载历史会话");
    });
    errSpy.mockRestore();
  });
});

// proxy_offline 不能重置 sessionListLoaded 或清空 sessions[]——chat.tsx 通过
// isRouteSessionEnded(session, sessionListLoaded) = "已加载且找不到 session" 来决定
// 是否清掉冷启动恢复的 lastChatRoute (route-restore.ts:39-47)。
//
// 如果 proxy_offline 改成清 sessions / 翻 sessionListLoaded=false, offline 那一瞬间
// 仍在该会话页的用户会触发 clearLastChatRoute, 之后 PWA 冷启动就再也不会恢复到原会话——
// 退化到 v0.2.1 之前的"息屏唤醒被甩回 session 选择页"体验。这个测试把这个隐式不变
// 量显式钉住, 改 phase-machine 的人会被红测试拦下来重新评估。
describe("phase-machine proxy_offline preserves session list for cold-start route restore", () => {
  beforeEach(() => {
    resetAppStore();
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
      sessionListLoaded: true,
    });
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: [], sessionListLoaded: false });
  });

  it("does not clear sessions or flip sessionListLoaded when current proxy goes offline", async () => {
    const relay = { listProxies: vi.fn(), clearBoundProxy: vi.fn() } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-1" }, timers, relay);

    const session = useSessionStore.getState();
    expect(session.sessions).toHaveLength(1);
    expect(session.sessions[0].sessionId).toBe("s1");
    expect(session.sessionListLoaded).toBe(true);
    expect(useAppStore.getState().proxyOnline).toBe(false);
  });

  it("does not clear sessions when an unrelated proxy goes offline", async () => {
    const relay = { listProxies: vi.fn() } as unknown as RelayClient;
    const timers: Timers = { reconnect: null, coldStartDone: true };

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-2" }, timers, relay);

    const session = useSessionStore.getState();
    expect(session.sessions).toHaveLength(1);
    expect(session.sessionListLoaded).toBe(true);
  });
});
