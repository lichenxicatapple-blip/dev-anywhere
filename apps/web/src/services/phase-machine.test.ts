import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayClient } from "@/services/relay-client";
import {
  createPhaseMachineTimers,
  disposePhaseMachineTimers,
  handleRelayMessage,
  handleWsStatusChange,
  type Timers,
} from "./phase-machine";
import { useAppStore } from "@/stores/app-store";
import { ptyAutoYesSessionKey, useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { useChatStore } from "@/stores/chat-store";
import { useCommandStore } from "@/stores/command-store";
import { router } from "@/lib/router";
import { getPendingProxyRemovals, markPendingProxyRemoval } from "@/services/proxy-removal-state";
import { previewController } from "@/services/preview-controller";
import { createPreviewScope } from "@/services/preview-scope";

vi.mock("@/lib/router", () => ({
  router: { navigate: vi.fn() },
}));

const toastError = vi.fn();
const toastWarning = vi.fn();
const previewScope = createPreviewScope("proxy-1", "binding-1");
vi.mock("@/components/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    success: vi.fn(),
  },
}));

function resetAppStore(): void {
  previewController.dispose();
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
  useSessionStore.setState({
    historySessions: [],
    historyLoadStatus: "idle",
    historyLoadGeneration: 0,
  });
}

function reconnectTimers(): Timers {
  const timers = createPhaseMachineTimers();
  timers.coldStartDone = true;
  return timers;
}

function emptyPreviewSnapshotMethods() {
  return {
    requestWebPreviewList: vi.fn().mockResolvedValue({
      epoch: "web-epoch",
      revision: 0,
      previews: [],
    }),
    requestDevicePreviewList: vi.fn().mockResolvedValue({
      epoch: "device-epoch",
      revision: 0,
      previews: [],
    }),
  };
}

function proxyStateInfo(homePath: string, agentCli: object = {}) {
  return {
    homePath,
    agentCli,
  };
}

describe("phase-machine reconnect timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppStore();
    vi.mocked(router.navigate).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("never exposes an authoritative empty proxy list while disconnecting", () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();
    const observed: Array<{ proxiesLength: number; proxyListLoaded: boolean }> = [];
    const unsubscribe = useAppStore.subscribe((state) => {
      observed.push({
        proxiesLength: state.proxies.length,
        proxyListLoaded: state.proxyListLoaded,
      });
    });

    handleWsStatusChange(false, timers, relay);
    unsubscribe();

    expect(observed).not.toContainEqual({ proxiesLength: 0, proxyListLoaded: true });
    expect(useAppStore.getState()).toMatchObject({ proxies: [], proxyListLoaded: false });
  });

  it("keeps one reconnect fallback timer across repeated disconnect notifications", () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    const firstTimer = timers.reconnect;

    handleWsStatusChange(false, timers, relay);

    expect(timers.reconnect).toBe(firstTimer);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(useAppStore.getState().phaseBeforeDisconnect).toBe("chatting");

    handleWsStatusChange(true, timers, relay);
    expect(timers.reconnect).toBe(firstTimer);

    vi.advanceTimersByTime(10_000);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(relay.register).toHaveBeenCalledTimes(1);
    expect(relay.listProxies).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying for 30 seconds before falling back to the connection page", () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);

    vi.advanceTimersByTime(29_999);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(router.navigate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().phase).toBe("connecting");
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("does not treat a raw WebSocket open as a completed reconnect", () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);

    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(useAppStore.getState().proxyOnline).toBe(false);

    vi.advanceTimersByTime(30_000);
    expect(useAppStore.getState().phase).toBe("connecting");
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("activates a restored registration scope and disposes it on disconnect", async () => {
    const relay = {
      getPreviewScope: vi.fn(() => previewScope),
      listProxies: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();
    useAppStore.setState({ phase: "registering" });

    await handleRelayMessage(
      {
        type: "client_register_response",
        status: "restored",
        proxyId: previewScope.proxyId,
        bindingId: previewScope.bindingId,
      },
      timers,
      relay,
    );

    expect(previewController.getActiveScope()).toEqual(previewScope);
    expect(useAppStore.getState().phase).toBe("proxy_selecting");

    handleWsStatusChange(false, timers, relay);
    expect(previewController.getActiveScope()).toBeNull();
  });

  it("keeps proxy input offline while reconnect binding is still pending", async () => {
    let resolveSelect!: (value: { success: true; proxyId: string }) => void;
    const selectResult = new Promise<{ success: true; proxyId: string }>((resolve) => {
      resolveSelect = resolve;
    });
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      register: vi.fn(),
      listProxies: vi.fn(),
      getBoundProxyId: vi.fn(() => null),
      getPreviewScope: vi.fn(() => previewScope),
      selectProxy: vi.fn(() => selectResult),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn().mockResolvedValue(proxyStateInfo("/h")),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);
    const handling = handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    await Promise.resolve();
    expect(useAppStore.getState().proxyOnline).toBe(false);
    expect(useAppStore.getState().phase).toBe("reconnecting");

    resolveSelect({ success: true, proxyId: "proxy-1" });
    await handling;
    expect(useAppStore.getState().proxyOnline).toBe(true);
    expect(useAppStore.getState().phase).toBe("chatting");
  });

  it("retries a transient reconnect binding failure without another proxy list push", async () => {
    let boundProxyId: string | null = null;
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      register: vi.fn(() => {
        boundProxyId = null;
      }),
      listProxies: vi.fn(),
      getBoundProxyId: vi.fn(() => boundProxyId),
      getPreviewScope: vi.fn(() => previewScope),
      selectProxy: vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: "weak network" })
        .mockImplementation(async (proxyId: string) => {
          boundProxyId = proxyId;
          return { success: true, proxyId };
        }),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn().mockResolvedValue(proxyStateInfo("/h")),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    expect(relay.selectProxy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(useAppStore.getState().proxyOnline).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(relay.selectProxy).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().phase).toBe("chatting");
    expect(useAppStore.getState().proxyOnline).toBe(true);
    expect(timers.bindingRetry).toBeNull();
    expect(timers.reconnect).toBeNull();

    vi.advanceTimersByTime(30_000);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("bounds reconnect binding retries by the 30 second fallback", async () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
      getBoundProxyId: vi.fn(() => null),
      selectProxy: vi.fn().mockResolvedValue({ success: false, error: "weak network" }),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(relay.selectProxy).toHaveBeenCalledTimes(17);

    await vi.advanceTimersByTimeAsync(1);
    expect(useAppStore.getState().phase).toBe("connecting");
    expect(timers.reconnect).toBeNull();
    expect(timers.bindingRetry).toBeNull();
    const attemptsAtFallback = vi.mocked(relay.selectProxy).mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.selectProxy).toHaveBeenCalledTimes(attemptsAtFallback);
  });

  it("invalidates an in-flight binding when the socket disconnects again", async () => {
    let resolveSelect!: (value: { success: true; proxyId: string }) => void;
    const selectResult = new Promise<{ success: true; proxyId: string }>((resolve) => {
      resolveSelect = resolve;
    });
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
      getBoundProxyId: vi.fn(() => null),
      getPreviewScope: vi.fn(() => previewScope),
      selectProxy: vi.fn(() => selectResult),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn(),
      requestAgentStatuses: vi.fn(),
      requestSessionHistory: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);
    const handling = handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );
    await Promise.resolve();

    handleWsStatusChange(false, timers, relay);
    resolveSelect({ success: true, proxyId: "proxy-1" });
    await handling;

    expect(useAppStore.getState().connected).toBe(false);
    expect(useAppStore.getState().proxyOnline).toBe(false);
    expect(useAppStore.getState().phase).toBe("reconnecting");
    expect(relay.sendControl).not.toHaveBeenCalled();
  });

  it("clears fallback and retry work when the phase machine is disposed", async () => {
    const relay = {
      register: vi.fn(),
      listProxies: vi.fn(),
      getBoundProxyId: vi.fn(() => null),
      selectProxy: vi.fn().mockResolvedValue({ success: false, error: "weak network" }),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    handleWsStatusChange(false, timers, relay);
    handleWsStatusChange(true, timers, relay);
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );
    expect(timers.reconnect).not.toBeNull();
    expect(timers.bindingRetry).not.toBeNull();

    disposePhaseMachineTimers(timers);
    expect(timers.reconnect).toBeNull();
    expect(timers.bindingRetry).toBeNull();
    const attemptsAtDispose = vi.mocked(relay.selectProxy).mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.selectProxy).toHaveBeenCalledTimes(attemptsAtDispose);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("reselects the current proxy when it returns after a graceful proxy restart", async () => {
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      getPreviewScope: vi.fn(() => previewScope),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockResolvedValue(
        proxyStateInfo("/Users/catli", {
          claude: { available: true, command: "claude" },
          codex: { available: true, command: "codex" },
        }),
      ),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

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

  it("resynchronizes both preview kinds when an offline restored binding comes online", async () => {
    const requestWebPreviewList = vi.fn().mockResolvedValue({
      epoch: "web-epoch",
      revision: 0,
      previews: [],
    });
    const requestDevicePreviewList = vi.fn().mockResolvedValue({
      epoch: "device-epoch",
      revision: 0,
      previews: [],
    });
    const relay = {
      getBoundProxyId: vi.fn(() => "proxy-1"),
      getPreviewScope: vi.fn(() => previewScope),
      listProxies: vi.fn(),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn().mockResolvedValue({
        homePath: "/h",
        agentCli: {},
      }),
      requestWebPreviewList,
      requestDevicePreviewList,
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestSessionHistory: vi.fn().mockResolvedValue([]),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    await handleRelayMessage(
      {
        type: "client_register_response",
        status: "proxy_offline",
        proxyId: previewScope.proxyId,
        bindingId: previewScope.bindingId,
      },
      timers,
      relay,
    );
    await handleRelayMessage({ type: "proxy_online", proxyId: "proxy-1" }, timers, relay);

    await vi.waitFor(() => {
      expect(requestWebPreviewList).toHaveBeenCalledWith(
        previewScope,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(requestDevicePreviewList).toHaveBeenCalledWith(
        previewScope,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(relay.sendControl).toHaveBeenCalledWith({ type: "session_list" });
    expect(relay.requestSessionHistory).toHaveBeenCalledWith(15_000);
  });

  it("does not resync proxy state when a proxy list confirms an existing binding", async () => {
    const relay = {
      getBoundProxyId: vi.fn(() => "proxy-1"),
      selectProxy: vi.fn(),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn(),
      requestAgentStatuses: vi.fn(),
      requestSessionHistory: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();
    useAppStore.setState({ proxyOnline: false });

    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    expect(useAppStore.getState().proxyOnline).toBe(true);
    expect(relay.selectProxy).not.toHaveBeenCalled();
    expect(relay.sendControl).not.toHaveBeenCalled();
    expect(relay.requestProxyInfo).not.toHaveBeenCalled();
    expect(relay.requestAgentStatuses).not.toHaveBeenCalled();
    expect(relay.requestSessionHistory).not.toHaveBeenCalled();
  });
});

describe("phase-machine request failure handling", () => {
  beforeEach(() => {
    resetAppStore();
    toastError.mockClear();
    toastWarning.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("surfaces requestProxyInfo failure via toast and does not crash subsequent flow", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let boundProxyId: string | null = "proxy-1";
    const previewSnapshots = emptyPreviewSnapshotMethods();
    const relay = {
      ...previewSnapshots,
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      getPreviewScope: vi.fn(() => previewScope),
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
    const timers = reconnectTimers();

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
      expect(previewSnapshots.requestWebPreviewList).toHaveBeenCalledWith(
        previewScope,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(previewSnapshots.requestDevicePreviewList).toHaveBeenCalledWith(
        previewScope,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    // 失败不应阻断后续 phase 推进
    expect(useAppStore.getState().phase).toBe("chatting");
    errSpy.mockRestore();
  });

  it("surfaces session history failure after the connection is stable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      clearBoundProxy: vi.fn((proxyId?: string) => {
        if (!proxyId || proxyId === boundProxyId) boundProxyId = null;
      }),
      getBoundProxyId: vi.fn(() => boundProxyId),
      getPreviewScope: vi.fn(() => previewScope),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockResolvedValue(
        proxyStateInfo("/h", {
          claude: { available: true, command: "c" },
          codex: { available: true, command: "c" },
        }),
      ),
      requestSessionHistory: vi.fn().mockRejectedValue(new Error("relay down")),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

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
      expect(toastWarning).toHaveBeenCalledWith("历史会话加载失败，可点击刷新重试");
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(relay.requestSessionHistory).toHaveBeenCalledWith(15_000);
    expect(useSessionStore.getState().historyLoadStatus).toBe("error");
    expect(useAppStore.getState().phase).toBe("chatting");
    errSpy.mockRestore();
  });

  it("suppresses a stale history failure while the socket is reconnecting", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectHistory!: (reason: Error) => void;
    const historyRequest = new Promise<never>((_resolve, reject) => {
      rejectHistory = reject;
    });
    let boundProxyId: string | null = "proxy-1";
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      getBoundProxyId: vi.fn(() => boundProxyId),
      getPreviewScope: vi.fn(() => previewScope),
      listProxies: vi.fn(),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestProxyInfo: vi.fn().mockResolvedValue(
        proxyStateInfo("/h", {
          claude: { available: true, command: "c" },
          codex: { available: true, command: "c" },
        }),
      ),
      requestSessionHistory: vi.fn(() => historyRequest),
      selectProxy: vi.fn().mockImplementation(async (proxyId: string) => {
        boundProxyId = proxyId;
        return { success: true, proxyId };
      }),
      sendControl: vi.fn(),
    } as unknown as RelayClient;
    const timers = reconnectTimers();

    useAppStore.setState({ phase: "reconnecting", connected: true, proxyOnline: true });
    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: true, sessions: ["s1"] }],
      },
      timers,
      relay,
    );

    useAppStore.setState({ phase: "reconnecting", connected: false, proxyOnline: false });
    rejectHistory(new Error("连接已断开"));

    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("phase-machine cold-start history", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAppStore();
    useAppStore.setState({
      phase: "proxy_selecting",
      selectedProxyId: null,
      selectedProxyName: null,
      proxyOnline: false,
    });
    window.location.hash = "#/chat/deep-session?mode=json";
  });

  afterEach(() => {
    window.location.hash = "#/";
    localStorage.clear();
  });

  it("loads history after binding a pasted deep link without a saved proxy", async () => {
    const history = [
      {
        id: "history-deep-link",
        title: "Deep link history",
        projectDir: "/workspace",
        updatedAt: 1,
        provider: "claude" as const,
      },
    ];
    const proxies = [
      {
        proxyId: "proxy-1",
        name: "DEV Mac",
        online: true,
        sessions: ["deep-session"],
      },
    ];
    const relay = {
      ...emptyPreviewSnapshotMethods(),
      requestProxyList: vi.fn().mockResolvedValue(proxies),
      getPreviewScope: vi.fn(() => previewScope),
      selectProxy: vi.fn().mockResolvedValue({ success: true, proxyId: "proxy-1" }),
      sendControl: vi.fn(),
      requestProxyInfo: vi.fn().mockResolvedValue(proxyStateInfo("/h")),
      requestAgentStatuses: vi.fn().mockResolvedValue([]),
      requestSessionHistory: vi.fn().mockResolvedValue(history),
    } as unknown as RelayClient;
    const timers = createPhaseMachineTimers();

    await handleRelayMessage({ type: "proxy_list_response", proxies }, timers, relay);

    await vi.waitFor(() => {
      expect(useSessionStore.getState()).toMatchObject({
        historyLoadStatus: "loaded",
        historySessions: history,
      });
    });
    expect(relay.requestSessionHistory).toHaveBeenCalledTimes(1);
    expect(relay.requestSessionHistory).toHaveBeenCalledWith(15_000);
    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: "proxy-1",
      proxyOnline: true,
      phase: "chatting",
    });
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
    const timers = reconnectTimers();

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-1" }, timers, relay);

    const session = useSessionStore.getState();
    expect(session.sessions).toHaveLength(1);
    expect(session.sessions[0].sessionId).toBe("s1");
    expect(session.sessionListLoaded).toBe(true);
    expect(useAppStore.getState().proxyOnline).toBe(false);
  });

  it("does not clear sessions when an unrelated proxy goes offline", async () => {
    const relay = { listProxies: vi.fn() } as unknown as RelayClient;
    const timers = reconnectTimers();

    await handleRelayMessage({ type: "proxy_offline", proxyId: "proxy-2" }, timers, relay);

    const session = useSessionStore.getState();
    expect(session.sessions).toHaveLength(1);
    expect(session.sessionListLoaded).toBe(true);
  });
});

describe("phase-machine explicit proxy removal", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAppStore();
    localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "idle" }],
      sessionListLoaded: true,
      loadingProxyName: null,
    });
    useFileStore.setState({
      tree: new Map([["/repo", [{ name: "src", isDir: true }]]]),
      cwd: "/repo",
      homePath: "/home/dev",
      agentCli: null,
    });
    useChatStore.setState({
      bySessionId: {
        s1: {
          messages: [],
          followLatestRequest: 0,
          turnCompletionVersion: 0,
          historyInitialized: false,
          historyHasMore: false,
          historyNextBefore: null,
          historyLoading: false,
          workingToolName: "",
          pendingApprovals: [],
          quotedMessage: null,
          inputDraft: "draft",
          draftAttachments: [],
        },
      },
    });
    useCommandStore.setState({
      commands: [{ name: "review", description: "Review", source: "test" }],
      lastUpdated: 1,
      activeSessionId: "s1",
      commandsBySessionId: {
        s1: [{ name: "review", description: "Review", source: "test" }],
      },
      legacyCommands: [],
    });
    vi.mocked(router.navigate).mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useChatStore.getState().clearAllSessions();
  });

  it("clears every selected-proxy snapshot and returns all tabs to proxy selection", async () => {
    const relay = {
      clearBoundProxy: vi.fn(),
      getPreviewScope: vi.fn(() => previewScope),
    } as unknown as RelayClient;
    const timers = reconnectTimers();
    previewController.activate(relay, previewScope);

    await handleRelayMessage({ type: "proxy_removed", proxyId: "proxy-1" }, timers, relay);

    expect(relay.clearBoundProxy).toHaveBeenCalledWith("proxy-1");
    expect(previewController.getActiveScope()).toBeNull();
    expect(useAppStore.getState()).toMatchObject({
      phase: "proxy_selecting",
      selectedProxyId: null,
      selectedProxyName: null,
      proxyOnline: false,
      proxies: [],
    });
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      sessionListLoaded: false,
      loadingProxyName: null,
    });
    expect(useFileStore.getState()).toMatchObject({ cwd: "", homePath: "" });
    expect(useFileStore.getState().tree.size).toBe(0);
    expect(useChatStore.getState().bySessionId).toEqual({});
    expect(useCommandStore.getState()).toMatchObject({
      commands: [],
      activeSessionId: null,
      commandsBySessionId: {},
    });
    expect(localStorage.getItem("dev_anywhere_proxyId")).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("only removes an unrelated proxy row without disturbing the current binding", async () => {
    const currentGrant = ptyAutoYesSessionKey("proxy-1", "s1");
    const removedGrant = ptyAutoYesSessionKey("proxy-2", "s2");
    if (!currentGrant || !removedGrant) throw new Error("missing PTY grant key");
    useAppStore.setState({
      proxies: [
        { proxyId: "proxy-1", name: "Current", online: true, sessions: ["s1"] },
        { proxyId: "proxy-2", name: "Old Mac", online: false, sessions: [] },
      ],
    });
    useSessionStore.setState({
      ptyAutoYesBySessionKey: { [currentGrant]: true, [removedGrant]: true },
    });
    const relay = {
      clearBoundProxy: vi.fn(),
      getPreviewScope: vi.fn(() => previewScope),
    } as unknown as RelayClient;
    previewController.activate(relay, previewScope);

    await handleRelayMessage(
      { type: "proxy_removed", proxyId: "proxy-2" },
      reconnectTimers(),
      relay,
    );

    expect(useAppStore.getState()).toMatchObject({
      phase: "chatting",
      selectedProxyId: "proxy-1",
      proxyOnline: true,
    });
    expect(useAppStore.getState().proxies.map((proxy) => proxy.proxyId)).toEqual(["proxy-1"]);
    expect(useSessionStore.getState()).toMatchObject({
      sessionListLoaded: true,
      ptyAutoYesBySessionKey: { [currentGrant]: true },
    });
    expect(useSessionStore.getState().sessions.map((session) => session.sessionId)).toEqual(["s1"]);
    expect(relay.clearBoundProxy).toHaveBeenCalledWith("proxy-2");
    expect(previewController.getActiveScope()).toEqual(previewScope);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("treats a successful ACK as authoritative if the following broadcast is lost", async () => {
    const relay = { clearBoundProxy: vi.fn() } as unknown as RelayClient;

    await handleRelayMessage(
      {
        type: "proxy_remove_response",
        requestId: "remove-1",
        proxyId: "proxy-1",
        success: true,
      },
      reconnectTimers(),
      relay,
    );

    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: null,
      proxyOnline: false,
      phase: "proxy_selecting",
    });
    expect(localStorage.getItem("dev_anywhere_proxyId")).toBeNull();
    expect(relay.clearBoundProxy).toHaveBeenCalledWith("proxy-1");
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("keeps cleanup idempotent when the success ACK is followed by the broadcast", async () => {
    const relay = { clearBoundProxy: vi.fn() } as unknown as RelayClient;
    const timers = reconnectTimers();

    await handleRelayMessage(
      {
        type: "proxy_remove_response",
        requestId: "remove-1",
        proxyId: "proxy-1",
        success: true,
      },
      timers,
      relay,
    );
    await handleRelayMessage({ type: "proxy_removed", proxyId: "proxy-1" }, timers, relay);

    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: null,
      phase: "proxy_selecting",
      proxies: [],
    });
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it("clears a remembered cold-start selection even before selectedProxyId is restored", async () => {
    useAppStore.setState({
      phase: "proxy_selecting",
      selectedProxyId: null,
      selectedProxyName: null,
      proxyOnline: false,
    });
    const relay = { clearBoundProxy: vi.fn() } as unknown as RelayClient;

    await handleRelayMessage(
      { type: "proxy_removed", proxyId: "proxy-1" },
      reconnectTimers(),
      relay,
    );

    expect(localStorage.getItem("dev_anywhere_proxyId")).toBeNull();
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("treats PROXY_NOT_FOUND as idempotent completion after an earlier lost ACK", async () => {
    const relay = { clearBoundProxy: vi.fn() } as unknown as RelayClient;

    await handleRelayMessage(
      {
        type: "proxy_remove_response",
        requestId: "remove-retry",
        proxyId: "proxy-1",
        success: false,
        errorCode: "PROXY_NOT_FOUND",
      },
      reconnectTimers(),
      relay,
    );

    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: null,
      phase: "proxy_selecting",
    });
    expect(localStorage.getItem("dev_anywhere_proxyId")).toBeNull();
  });

  it("finishes a removal from the first authoritative list after every direct response was lost", async () => {
    markPendingProxyRemoval("proxy-1");
    const relay = { clearBoundProxy: vi.fn() } as unknown as RelayClient;

    await handleRelayMessage(
      { type: "proxy_list_response", proxies: [] },
      reconnectTimers(),
      relay,
    );

    expect(getPendingProxyRemovals()).toEqual([]);
    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: null,
      phase: "proxy_selecting",
      proxies: [],
    });
    expect(localStorage.getItem("dev_anywhere_proxyId")).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith("/");
  });

  it("keeps the current selection when the fresh list proves the remove request did not land", async () => {
    markPendingProxyRemoval("proxy-1");
    const relay = { getBoundProxyId: vi.fn(() => "proxy-1") } as unknown as RelayClient;

    await handleRelayMessage(
      {
        type: "proxy_list_response",
        proxies: [{ proxyId: "proxy-1", name: "DEV Mac", online: false, sessions: ["s1"] }],
      },
      reconnectTimers(),
      relay,
    );

    expect(getPendingProxyRemovals()).toEqual([]);
    expect(useAppStore.getState()).toMatchObject({
      selectedProxyId: "proxy-1",
      phase: "chatting",
    });
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
