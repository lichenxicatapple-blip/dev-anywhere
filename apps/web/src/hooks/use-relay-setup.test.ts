import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const relaySetupMocks = vi.hoisted(() => {
  const wsManager = {
    connect: vi.fn<(url: string) => void>(),
  };
  const runtime = {
    wsManagerRef: wsManager,
    relayClientRef: null,
  };
  (
    globalThis as typeof globalThis & {
      __devAnywhereRelayRuntime?: typeof runtime;
    }
  ).__devAnywhereRelayRuntime = runtime;

  return {
    checkRelayClientAuth:
      vi.fn<
        (
          relayUrl: string,
          token: string | null,
          signal?: AbortSignal,
        ) => Promise<"missing_client_token" | "invalid_client_token" | null>
      >(),
    wsManager,
  };
});

vi.mock("@/lib/relay-client-auth", () => ({
  checkRelayClientAuth: relaySetupMocks.checkRelayClientAuth,
}));

import { reconnectRelayClient } from "./use-relay-setup";
import { RelayReconnectAttemptTimeoutError } from "@/services/relay-reconnect-loop";
import {
  clearRelayClientToken,
  getRelayClientToken,
  persistRelayClientToken,
} from "@/lib/relay-client-token";
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

describe("reconnectRelayClient", () => {
  beforeEach(() => {
    relaySetupMocks.checkRelayClientAuth.mockReset();
    relaySetupMocks.wsManager.connect.mockReset();
    clearRelayClientToken();
    useAppStore.setState({
      phase: "connecting",
      connected: false,
      proxyOnline: false,
      selectedProxyId: null,
      selectedProxyName: null,
      proxies: [],
      proxyListLoaded: false,
      relayUrl: "https://relay.example.com",
      relayClientAuthIssue: null,
      relayConnectionIssue: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRelayClientToken();
  });

  it("ignores an old invalid-token result after a newer token has connected", async () => {
    const oldAuth = deferred<"invalid_client_token" | null>();
    const newAuth = deferred<"invalid_client_token" | null>();
    relaySetupMocks.checkRelayClientAuth
      .mockReturnValueOnce(oldAuth.promise)
      .mockReturnValueOnce(newAuth.promise);

    persistRelayClientToken("old-token");
    const oldReconnect = reconnectRelayClient();
    expect(relaySetupMocks.checkRelayClientAuth).toHaveBeenNthCalledWith(
      1,
      "https://relay.example.com",
      "old-token",
      expect.any(AbortSignal),
    );

    persistRelayClientToken("new-token");
    const newReconnect = reconnectRelayClient();
    const oldSignal = relaySetupMocks.checkRelayClientAuth.mock.calls[0]?.[2];
    expect(oldSignal?.aborted).toBe(true);
    newAuth.resolve(null);
    await newReconnect;

    oldAuth.resolve("invalid_client_token");
    await oldReconnect;

    expect(getRelayClientToken()).toBe("new-token");
    expect(useAppStore.getState()).toMatchObject({
      relayClientAuthIssue: null,
      relayConnectionIssue: null,
    });
    expect(relaySetupMocks.wsManager.connect).toHaveBeenCalledTimes(1);
    expect(relaySetupMocks.wsManager.connect).toHaveBeenCalledWith(
      "wss://relay.example.com/client?token=new-token",
    );
  });

  it("marks a standalone authentication preflight unavailable at its timeout boundary", async () => {
    vi.useFakeTimers();
    let attemptSignal: AbortSignal | undefined;
    relaySetupMocks.checkRelayClientAuth.mockImplementationOnce((_relayUrl, _token, signal) => {
      attemptSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const reconnect = reconnectRelayClient();
    const rejected = expect(reconnect).rejects.toBeInstanceOf(RelayReconnectAttemptTimeoutError);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(attemptSignal?.aborted).toBe(false);
    expect(useAppStore.getState().relayConnectionIssue).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(attemptSignal?.aborted).toBe(true);
    expect(attemptSignal?.reason).toBeInstanceOf(RelayReconnectAttemptTimeoutError);
    expect(useAppStore.getState().relayConnectionIssue).toBe("unreachable");
    expect(relaySetupMocks.wsManager.connect).not.toHaveBeenCalled();
  });
});
