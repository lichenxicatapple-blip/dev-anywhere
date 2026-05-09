import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayClient } from "@/services/relay-client";
import { handleWsStatusChange, type Timers } from "./phase-machine";
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
});
