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

  const timers: Timers = { reconnect: null, coldStartDone: false };

  const nav: PhaseNav = {
    reLaunch: vi.fn(),
    navigateTo: vi.fn(),
    showToast: vi.fn(),
    getStorageSync: vi.fn(() => ""),
    getCurrentPath: vi.fn(() => "pages/proxy-select/index"),
  };

  const relay: PhaseRelay = {
    register: vi.fn(),
    listProxies: vi.fn(),
    selectProxy: vi.fn(() => Promise.resolve({ success: true, proxyId: "p1" })),
    requestProxyList: vi.fn(() => Promise.resolve([])),
    getBoundProxyId: vi.fn(() => null),
  };

  return { getState, dispatch, dispatched, timers, nav, relay };
}

function findAction(actions: AppAction[], type: string): AppAction | undefined {
  return actions.find((a) => a.type === type);
}

describe("handleWsStatusChange", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ws connect from connecting: transitions to registering, calls register, does NOT call listProxies", () => {
    const env = createTestEnv("connecting");
    handleWsStatusChange(true, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(findAction(env.dispatched, "SET_CONNECTED")).toEqual({ type: "SET_CONNECTED", connected: true });
    expect(findAction(env.dispatched, "SET_PHASE")).toEqual({ type: "SET_PHASE", phase: "registering" });
    expect(env.relay.register).toHaveBeenCalled();
    expect(env.relay.listProxies).not.toHaveBeenCalled();
  });

  it("ws connect from reconnecting: clears reconnect timer, calls register + listProxies + selectProxy", () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "chatting",
    });
    env.timers.reconnect = setTimeout(() => {}, 99999);

    handleWsStatusChange(true, env.getState, env.dispatch, env.timers, env.relay, env.nav);

    expect(env.timers.reconnect).toBeNull();
    expect(env.relay.register).toHaveBeenCalled();
    expect(env.relay.listProxies).toHaveBeenCalled();
    expect(env.relay.selectProxy).toHaveBeenCalledWith("p1");
    // phase 不应在这里恢复，等 proxy_list_response 验证
    const phaseActions = env.dispatched.filter((a) => a.type === "SET_PHASE");
    expect(phaseActions).toHaveLength(0);
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

describe("handleRelayMessage: client_register_response", () => {
  it("from registering phase: calls listProxies, transitions to proxy_selecting", async () => {
    const env = createTestEnv("registering");

    await handleRelayMessage(
      { type: "client_register_response", status: "new" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.relay.listProxies).toHaveBeenCalled();
    expect(env.getState().phase).toBe("proxy_selecting");
  });

  it("from non-registering phase: ignored (no phase change)", async () => {
    const env = createTestEnv("proxy_selecting");

    await handleRelayMessage(
      { type: "client_register_response", status: "new" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.relay.listProxies).not.toHaveBeenCalled();
    expect(env.getState().phase).toBe("proxy_selecting");
  });
});

describe("handleRelayMessage: proxy_offline / proxy_online", () => {
  it("proxy_offline for selected proxy: sets proxyOnline=false, shows toast, refreshes list", async () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });

    await handleRelayMessage(
      { type: "proxy_offline", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().proxyOnline).toBe(false);
    expect(env.getState().phase).toBe("chatting");
    expect(env.nav.showToast).toHaveBeenCalledWith("Proxy offline");
    expect(env.relay.listProxies).toHaveBeenCalled();
    expect(env.nav.reLaunch).not.toHaveBeenCalled();
  });

  it("proxy_offline for different proxy: refreshes list, no toast", async () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1" });

    await handleRelayMessage(
      { type: "proxy_offline", proxyId: "p2" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.relay.listProxies).toHaveBeenCalled();
    expect(env.nav.showToast).not.toHaveBeenCalled();
  });

  it("proxy_online for selected proxy: sets proxyOnline=true, shows toast, refreshes list", async () => {
    const env = createTestEnv("chatting", { selectedProxyId: "p1", proxyOnline: false });

    await handleRelayMessage(
      { type: "proxy_online", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().proxyOnline).toBe(true);
    expect(env.getState().phase).toBe("chatting");
    expect(env.nav.showToast).toHaveBeenCalledWith("Proxy reconnected");
    expect(env.relay.listProxies).toHaveBeenCalled();
  });

  it("proxy_offline then proxy_online: proxyOnline toggles, phase never changes, list refreshed each time", async () => {
    const env = createTestEnv("session_browsing", { selectedProxyId: "p1", proxyOnline: true });

    await handleRelayMessage(
      { type: "proxy_offline", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.getState().proxyOnline).toBe(false);
    expect(env.getState().phase).toBe("session_browsing");
    expect(env.relay.listProxies).toHaveBeenCalledTimes(1);

    await handleRelayMessage(
      { type: "proxy_online", proxyId: "p1" },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.getState().proxyOnline).toBe(true);
    expect(env.getState().phase).toBe("session_browsing");
    expect(env.relay.listProxies).toHaveBeenCalledTimes(2);
  });
});

describe("handleRelayMessage: proxy_list_response cold start", () => {
  it("cold start with saved proxyId + sessionId: calls ensureBinding, transitions to chatting", async () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        if (key === "cc_sessionId") return "s1";
        return "";
      });

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "My Proxy", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.getState().selectedProxyId).toBe("p1");
    expect(env.relay.selectProxy).toHaveBeenCalledWith("p1");
    expect(env.nav.navigateTo).toHaveBeenCalledWith("/pages/chat/index?sessionId=s1&mode=json");
  });

  it("cold start with saved proxyId only: calls ensureBinding, transitions to session_browsing", async () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        return "";
      });

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("session_browsing");
    expect(env.nav.navigateTo).toHaveBeenCalledWith("/pages/session-list/index");
  });

  it("cold start fires only once", async () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        return "";
      });
    const proxies = [{ proxyId: "p1", name: "P", online: true }];

    await handleRelayMessage(
      { type: "proxy_list_response", proxies },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.nav.navigateTo).toHaveBeenCalledTimes(1);

    // 模拟用户返回 proxy-select
    env.dispatch({ type: "SET_PHASE", phase: "proxy_selecting" });
    (env.nav.navigateTo as ReturnType<typeof vi.fn>).mockClear();

    await handleRelayMessage(
      { type: "proxy_list_response", proxies },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );
    expect(env.nav.navigateTo).not.toHaveBeenCalled();
  });

  it("cold start skipped when no saved proxyId, but proxies stored in state", async () => {
    const env = createTestEnv("proxy_selecting");
    const proxies = [{ proxyId: "p1", name: "P", online: true }];

    await handleRelayMessage(
      { type: "proxy_list_response", proxies },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.nav.navigateTo).not.toHaveBeenCalled();
    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.getState().proxies).toEqual(proxies);
  });

  it("cold start ensureBinding failure: stays in proxy_selecting", async () => {
    const env = createTestEnv("proxy_selecting");
    (env.nav.getStorageSync as ReturnType<typeof vi.fn>)
      .mockImplementation((key: string) => {
        if (key === "cc_proxyId") return "p1";
        return "";
      });
    (env.relay.selectProxy as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, error: "Proxy not found" });

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.navigateTo).not.toHaveBeenCalled();
  });
});

describe("handleRelayMessage: reconnect validation via proxy_list_response", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reconnecting + proxy still online: restores phaseBeforeDisconnect", async () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "chatting",
    });
    env.timers.coldStartDone = true;

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("chatting");
    expect(env.nav.reLaunch).not.toHaveBeenCalled();
  });

  it("reconnecting + proxy offline: falls back to proxy_selecting", async () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "chatting",
    });
    env.timers.coldStartDone = true;

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p1", name: "P", online: false }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });

  it("reconnecting + proxy not in list: falls back to proxy_selecting", async () => {
    const env = createTestEnv("reconnecting", {
      selectedProxyId: "p1",
      phaseBeforeDisconnect: "session_browsing",
    });
    env.timers.coldStartDone = true;

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [{ proxyId: "p2", name: "Other", online: true }] },
      env.getState, env.dispatch, env.timers, env.relay, env.nav,
    );

    expect(env.getState().phase).toBe("proxy_selecting");
    expect(env.nav.reLaunch).toHaveBeenCalledWith("/pages/proxy-select/index");
  });
});
