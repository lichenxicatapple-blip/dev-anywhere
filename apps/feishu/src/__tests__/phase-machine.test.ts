import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleWsStatusChange, handleRelayMessage } from "@/phase-machine";
import type { Timers, PhaseNav, PhaseRelay } from "@/phase-machine";
import { appReducer, initialAppState } from "@/stores/app-store";
import type { AppState, AppAction, AppPhase } from "@/stores/app-store";

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: vi.fn(() => ""),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
  },
}));

function createTestEnv(phase: AppPhase, overrides?: Partial<AppState>) {
  let state: AppState = { ...initialAppState, phase, ...overrides };
  const dispatched: AppAction[] = [];

  const dispatch = (action: AppAction) => {
    dispatched.push(action);
    state = appReducer(state, action);
  };
  const getState = () => state;

  const timers: Timers = { proxyLost: null, reconnect: null, coldStartDone: false };

  const nav: PhaseNav = {
    reLaunch: vi.fn(),
    navigateTo: vi.fn(),
    showToast: vi.fn(),
    getStorageSync: vi.fn(() => ""),
  };

  const relay: PhaseRelay = {
    register: vi.fn(),
    listProxies: vi.fn(),
    selectProxy: vi.fn(() => Promise.resolve({ success: true, proxyId: "p1" })),
  };

  return { getState, dispatch, dispatched, timers, nav, relay };
}

function findAction(actions: AppAction[], type: string): AppAction | undefined {
  return actions.find((a) => a.type === type);
}

describe("handleWsStatusChange", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ws connect from connecting: transitions to proxy_selecting", () => {
    const env = createTestEnv("connecting");
    handleWsStatusChange(true, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(findAction(env.dispatched, "SET_CONNECTED")).toEqual({ type: "SET_CONNECTED", connected: true });
    expect(findAction(env.dispatched, "SET_PHASE")).toEqual({ type: "SET_PHASE", phase: "proxy_selecting" });
    expect(env.relay.register).toHaveBeenCalled();
    expect(env.relay.listProxies).toHaveBeenCalled();
  });

  it("ws connect from reconnecting: clears reconnect timer, does not set phase", () => {
    const env = createTestEnv("reconnecting", { phaseBeforeDisconnect: "chatting" });
    env.timers.reconnect = setTimeout(() => {}, 99999);

    handleWsStatusChange(true, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(env.timers.reconnect).toBeNull();
    // phase 不应该在这里恢复，而是等 proxy_list_response 验证
    const phaseActions = env.dispatched.filter((a) => a.type === "SET_PHASE");
    expect(phaseActions).toHaveLength(0);
    expect(env.relay.register).toHaveBeenCalled();
  });

  it("ws disconnect from chatting: enters reconnecting with 10s timer", () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });
    handleWsStatusChange(false, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(findAction(env.dispatched, "SET_PROXY_ONLINE")).toEqual({ type: "SET_PROXY_ONLINE", online: false });
    expect(findAction(env.dispatched, "SET_PHASE")).toEqual({ type: "SET_PHASE", phase: "reconnecting" });
    expect(env.timers.reconnect).not.toBeNull();
    expect(env.getState().phaseBeforeDisconnect).toBe("chatting");
  });

  it("ws disconnect from connecting: no reconnecting phase", () => {
    const env = createTestEnv("connecting");
    handleWsStatusChange(false, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(findAction(env.dispatched, "SET_PROXY_ONLINE")).toEqual({ type: "SET_PROXY_ONLINE", online: false });
    const phaseActions = env.dispatched.filter((a) => a.type === "SET_PHASE");
    expect(phaseActions).toHaveLength(0);
    expect(env.timers.reconnect).toBeNull();
  });

  it("reconnect timeout (10s): transitions to connecting and reLaunch", () => {
    const env = createTestEnv("chatting");
    handleWsStatusChange(false, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    env.dispatched.length = 0;
    vi.advanceTimersByTime(10000);

    expect(env.timers.reconnect).toBeNull();
    expect(env.getState().phase).toBe("connecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });

  it("ws reconnect before 10s timeout: cancels timer", () => {
    const env = createTestEnv("session_browsing");

    handleWsStatusChange(false, env.getState, env.dispatch, env.timers, env.relay, env.nav);
    expect(env.timers.reconnect).not.toBeNull();

    handleWsStatusChange(true, env.getState, env.dispatch, env.timers, env.relay, env.nav);
    expect(env.timers.reconnect).toBeNull();

    vi.advanceTimersByTime(10000);
    expect(env.nav.reLaunch).not.toHaveBeenCalled();
  });
});

describe("handleRelayMessage: proxy_offline / proxy_online", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("proxy_offline for selected proxy: enters proxy_lost with 1.5s timer", () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });

    handleRelayMessage(
      { type: "proxy_offline", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_lost");
    expect(env.getState().phaseBeforeDisconnect).toBe("chatting");
    expect(env.timers.proxyLost).not.toBeNull();
    expect(env.nav.showToast).toHaveBeenCalledWith("Proxy disconnected");
  });

  it("proxy_offline for different proxy: no action", () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });

    handleRelayMessage(
      { type: "proxy_offline", proxyId: "p2" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.timers.proxyLost).toBeNull();
  });

  it("proxy_online within 1.5s: cancels timer and restores phase", () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });

    handleRelayMessage(
      { type: "proxy_offline", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.getState().phase).toBe("proxy_lost");

    handleRelayMessage(
      { type: "proxy_online", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.timers.proxyLost).toBeNull();
    expect(env.getState().phase).toBe("chatting");
    expect(env.getState().proxyOnline).toBe(true);
    expect(env.nav.showToast).toHaveBeenCalledWith("Proxy reconnected");
  });

  it("proxy_lost timeout (1.5s): transitions to proxy_selecting and reLaunch", () => {
    const env = createTestEnv("session_browsing", { selectedProxyId: "p1" });

    handleRelayMessage(
      { type: "proxy_offline", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    vi.advanceTimersByTime(1500);

    expect(env.timers.proxyLost).toBeNull();
    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });
});

describe("handleRelayMessage: proxy_list_response cold start", () => {
  it("cold start with proxy+session: navigates to chat", () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        if (key === "cc_sessionId") return "s1";
        return "";
      });

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "My Proxy", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.getState().selectedProxyId).toBe("p1");
    expect(env.relay.selectProxy).toHaveBeenCalledWith("p1");
    expect(env.nav.navigateTo).toHaveBeenCalledWith("/pages/chat/index?sessionId=s1&mode=json");
  });

  it("cold start with proxy only: navigates to session-list", () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        return "";
      });

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("session_browsing");
    expect(env.nav.navigateTo).toHaveBeenCalledWith("/pages/session-list/index");
  });

  it("cold start fires only once, even if phase returns to proxy_selecting", () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        return "";
      });
    const proxies = [{ proxyId: "p1", name: "P", online: true }];

    handleRelayMessage(
      { type: "proxy_list_response", proxies },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.nav.navigateTo).toHaveBeenCalledTimes(1);

    // 模拟用户返回 proxy-select，phase 回到 proxy_selecting
    env.dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
    expect(env.getState().phase).toBe("proxy_selecting");
    (env.nav.navigateTo as ReturnType<typeof vi.fn>).mockClear();

    // 再次收到 proxy_list_response，不应再触发冷启动
    handleRelayMessage(
      { type: "proxy_list_response", proxies },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.nav.navigateTo).not.toHaveBeenCalled();
  });

  it("cold start skipped when no saved proxyId", () => {
    const env = createTestEnv("proxy_selecting");

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.nav.navigateTo).not.toHaveBeenCalled();
    expect(env.getState().phase).toBe("proxy_selecting");
  });
});

describe("handleRelayMessage: reconnect validation via proxy_list_response", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reconnecting + proxy still online: restores phaseBeforeDisconnect", () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "chatting",
    });
    env.timers.coldStartDone = true;

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.nav.reLaunch).not.toHaveBeenCalled();
  });

  it("reconnecting + proxy offline: falls back to proxy_selecting", () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "chatting",
    });
    env.timers.coldStartDone = true;

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: false }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });

  it("reconnecting + proxy disappeared from list: falls back to proxy_selecting", () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "session_browsing",
    });
    env.timers.coldStartDone = true;

    handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p2", name: "Other", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });
});
