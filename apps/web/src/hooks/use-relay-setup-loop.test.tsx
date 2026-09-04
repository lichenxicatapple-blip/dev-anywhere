import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setupMocks = vi.hoisted(() => {
  const ws = {
    connect: vi.fn<(url: string) => void>(),
    close: vi.fn<() => void>(),
    onStatusChange: vi.fn(() => vi.fn()),
  };
  const relay = {
    onMessage: vi.fn(() => vi.fn()),
  };
  (
    globalThis as typeof globalThis & {
      __devAnywhereRelayRuntime?: { wsManagerRef: unknown; relayClientRef: unknown };
    }
  ).__devAnywhereRelayRuntime = { wsManagerRef: null, relayClientRef: null };

  return {
    ws,
    relay,
    checkRelayClientAuth:
      vi.fn<
        (
          relayUrl: string,
          token: string | null,
          signal?: AbortSignal,
        ) => Promise<"missing_client_token" | "invalid_client_token" | null>
      >(),
    disposePreview: vi.fn(),
  };
});

vi.mock("@/services/websocket", () => ({
  WebSocketManager: function WebSocketManager() {
    return setupMocks.ws;
  },
}));

vi.mock("@/services/relay-client", () => ({
  RelayClient: function RelayClient() {
    return setupMocks.relay;
  },
}));

vi.mock("@/services/phase-machine", () => ({
  createPhaseMachineTimers: () => ({}),
  disposePhaseMachineTimers: vi.fn(),
  handleWsStatusChange: vi.fn(),
  handleRelayMessage: vi.fn(),
}));

vi.mock("@/services/chat-dispatcher", () => ({ registerChatDispatcher: () => vi.fn() }));
vi.mock("@/services/session-dispatcher", () => ({ registerSessionDispatcher: () => vi.fn() }));
vi.mock("@/services/resource-dispatcher", () => ({
  registerResourceDispatcher: () => vi.fn(),
}));
vi.mock("@/services/preview-dispatcher", () => ({ registerPreviewDispatcher: () => vi.fn() }));
vi.mock("@/services/preview-controller", () => ({
  previewController: { dispose: setupMocks.disposePreview },
}));
vi.mock("@/lib/font-assets", () => ({ loadFontCSS: vi.fn() }));
vi.mock("@/lib/relay-client-auth", () => ({
  checkRelayClientAuth: setupMocks.checkRelayClientAuth,
}));

import { reconnectRelayClient, useRelaySetup } from "./use-relay-setup";
import { clearRelayClientToken } from "@/lib/relay-client-token";
import { useAppStore } from "@/stores/app-store";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useRelaySetup reconnect ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupMocks.checkRelayClientAuth.mockReset();
    setupMocks.ws.connect.mockReset();
    setupMocks.ws.close.mockReset();
    setupMocks.ws.onStatusChange.mockClear();
    setupMocks.relay.onMessage.mockClear();
    setupMocks.disposePreview.mockReset();
    clearRelayClientToken();
    useAppStore.setState({
      phase: "connecting",
      connected: false,
      proxyOnline: false,
      selectedProxyId: null,
      selectedProxyName: null,
      proxies: [],
      proxyListLoaded: false,
      relayUrl: "",
      relayClientAuthIssue: null,
      relayConnectionIssue: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearRelayClientToken();
  });

  it("cancels a cold-start retry timer after a later manual reconnect succeeds", async () => {
    setupMocks.checkRelayClientAuth
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValue(null);

    const hook = renderHook(() => useRelaySetup());
    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().relayConnectionIssue).toBe("unreachable");

    await act(async () => reconnectRelayClient());

    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(2);
    expect(setupMocks.ws.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(2);
    expect(setupMocks.ws.connect).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it("keeps retry supervision after a manual reconnect supersedes an active startup attempt and fails", async () => {
    const manualAuth = deferred<null>();
    let startupSignal: AbortSignal | undefined;
    setupMocks.checkRelayClientAuth
      .mockImplementationOnce((_relayUrl, _token, signal) => {
        startupSignal = signal;
        return new Promise<null>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
      .mockReturnValueOnce(manualAuth.promise)
      .mockResolvedValue(null);

    const hook = renderHook(() => useRelaySetup());
    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(1);

    const manualReconnect = reconnectRelayClient();
    expect(startupSignal?.aborted).toBe(true);
    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(2);

    await act(async () => {
      manualAuth.reject(new Error("relay still down"));
      await expect(manualReconnect).rejects.toThrow("relay still down");
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(3);
    expect(setupMocks.ws.connect).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it("does not reconnect a disposed runtime when a manual preflight succeeds late", async () => {
    const lateManualAuth = deferred<null>();
    setupMocks.checkRelayClientAuth
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(lateManualAuth.promise);

    const hook = renderHook(() => useRelaySetup());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setupMocks.checkRelayClientAuth).toHaveBeenCalledTimes(1);
    expect(setupMocks.ws.connect).toHaveBeenCalledTimes(1);

    const manualReconnect = reconnectRelayClient();
    const manualSignal = setupMocks.checkRelayClientAuth.mock.calls[1]?.[2];
    expect(manualSignal?.aborted).toBe(false);

    hook.unmount();
    expect(manualSignal?.aborted).toBe(true);
    expect(setupMocks.ws.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      lateManualAuth.resolve(null);
      await manualReconnect;
    });

    expect(setupMocks.ws.connect).toHaveBeenCalledTimes(1);
  });
});
