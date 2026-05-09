import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayClient } from "@/services/relay-client";
import { handleRelayMessage, handleWsStatusChange, type Timers } from "./phase-machine";
import { useAppStore } from "@/stores/app-store";

vi.mock("@/lib/router", () => ({
  router: { navigate: vi.fn() },
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
