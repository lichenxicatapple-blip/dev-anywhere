import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ProxyProtocolAdmissionDirection } from "@dev-anywhere/shared";
import {
  createRelayUpgradeBootstrapMonitor,
  fetchRelayUpgradeBootstrap,
  relayUpgradeBootstrapUrl,
} from "#src/relay-upgrade-bootstrap.js";

const bootstrapBody = {
  bootstrapVersion: 1,
  relayVersion: "0.9.1",
  controlProtocolVersion: 1,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

describe("Relay upgrade bootstrap", () => {
  it("derives an HTTP endpoint without carrying Relay query parameters", () => {
    expect(relayUpgradeBootstrapUrl("wss://relay.example.test/team/?token=secret").toString()).toBe(
      "https://relay.example.test/team/api/proxy-upgrade-bootstrap",
    );
    expect(relayUpgradeBootstrapUrl("ws://127.0.0.1:3100").toString()).toBe(
      "http://127.0.0.1:3100/api/proxy-upgrade-bootstrap",
    );
  });

  it("authenticates and validates version discovery outside the WebSocket protocol", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(bootstrapBody));

    await expect(
      fetchRelayUpgradeBootstrap({
        relayUrl: "wss://relay.example.test",
        token: "proxy-secret",
        fetchImpl,
      }),
    ).resolves.toEqual(bootstrapBody);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://relay.example.test/api/proxy-upgrade-bootstrap"),
      expect.objectContaining({
        headers: { authorization: "Bearer proxy-secret" },
        redirect: "error",
        cache: "no-store",
      }),
    );
  });

  it("keeps the stable bootstrap readable when a future Relay adds negotiation hints", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...bootstrapBody,
        minimumProxyVersion: "0.10.0",
        recommendedAction: "upgrade",
      }),
    );

    await expect(
      fetchRelayUpgradeBootstrap({ relayUrl: "wss://relay.example.test", fetchImpl }),
    ).resolves.toEqual(bootstrapBody);
  });

  it("treats a missing endpoint as an older same-protocol Relay", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    await expect(
      fetchRelayUpgradeBootstrap({ relayUrl: "ws://127.0.0.1:3100", fetchImpl }),
    ).resolves.toBeNull();
  });

  it("rejects an invalid or unauthorized bootstrap response", async () => {
    const invalidFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...bootstrapBody, relayVersion: "latest" }));
    await expect(
      fetchRelayUpgradeBootstrap({ relayUrl: "ws://127.0.0.1:3100", fetchImpl: invalidFetch }),
    ).rejects.toThrow("invalid response");

    const unauthorizedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "invalid_proxy_token" }, 401));
    await expect(
      fetchRelayUpgradeBootstrap({
        relayUrl: "ws://127.0.0.1:3100",
        fetchImpl: unauthorizedFetch,
      }),
    ).rejects.toThrow("HTTP 401");
  });

  it("coalesces concurrent probes and forwards the discovered version once", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const onAdmission = vi.fn();
    const monitor = createRelayUpgradeBootstrapMonitor({
      relayUrl: "ws://127.0.0.1:3100",
      logger: testLogger(),
      onAdmission,
      fetchImpl,
    });

    monitor.request();
    monitor.request();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(bootstrapBody));
    await vi.waitFor(() =>
      expect(onAdmission).toHaveBeenCalledWith({
        direction: ProxyProtocolAdmissionDirection.COMPATIBLE,
        relayVersion: "0.9.1",
        relayControlProtocolVersion: 1,
      }),
    );
    expect(onAdmission).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("retries a transient failure until version discovery succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(jsonResponse(bootstrapBody));
    const onAdmission = vi.fn();
    const monitor = createRelayUpgradeBootstrapMonitor({
      relayUrl: "ws://127.0.0.1:3100",
      logger: testLogger(),
      onAdmission,
      fetchImpl,
      retryInitialMs: 1,
      retryMaxMs: 1,
    });

    monitor.request();
    await vi.waitFor(() => expect(onAdmission).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("backs off while Relay is older and reports compatibility when Relay catches up", async () => {
    vi.useFakeTimers();
    try {
      const olderRelay = { ...bootstrapBody, controlProtocolVersion: 1 } as const;
      const compatibleRelay = {
        ...bootstrapBody,
        relayVersion: "0.9.2",
        controlProtocolVersion: 2,
      } as const;
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(olderRelay))
        .mockResolvedValueOnce(jsonResponse(olderRelay))
        .mockResolvedValueOnce(jsonResponse(compatibleRelay));
      const onAdmission = vi.fn();
      const monitor = createRelayUpgradeBootstrapMonitor({
        relayUrl: "ws://127.0.0.1:3100",
        logger: testLogger(),
        onAdmission,
        fetchImpl,
        controlProtocolVersion: 2,
        retryInitialMs: 5,
        retryMaxMs: 20,
      });

      monitor.request();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onAdmission).toHaveBeenLastCalledWith({
        direction: ProxyProtocolAdmissionDirection.RELAY_OUTDATED,
        relayVersion: "0.9.1",
        relayControlProtocolVersion: 1,
      });

      await vi.advanceTimersByTimeAsync(5);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // Identical observations are coalesced, but polling continues with the next backoff step.
      expect(onAdmission).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(onAdmission).toHaveBeenLastCalledWith({
        direction: ProxyProtocolAdmissionDirection.COMPATIBLE,
        relayVersion: "0.9.2",
        relayControlProtocolVersion: 2,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on an invalid successful bootstrap response without retrying", async () => {
    vi.useFakeTimers();
    try {
      const onAdmission = vi.fn();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ bootstrapVersion: 1, relayVersion: "broken" }));
      const monitor = createRelayUpgradeBootstrapMonitor({
        relayUrl: "ws://127.0.0.1:3100",
        logger: testLogger(),
        onAdmission,
        fetchImpl,
        retryInitialMs: 1,
        retryMaxMs: 1,
      });

      monitor.request();
      await vi.advanceTimersByTimeAsync(0);
      expect(onAdmission).toHaveBeenCalledOnce();
      expect(onAdmission).toHaveBeenCalledWith({
        direction: ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale HTTP response after a newer probe has taken ownership", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const onAdmission = vi.fn();
    const monitor = createRelayUpgradeBootstrapMonitor({
      relayUrl: "ws://127.0.0.1:3100",
      logger: testLogger(),
      onAdmission,
      fetchImpl,
    });

    monitor.request();
    monitor.markControlProtocolConnected();
    monitor.request();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolvers[0]?.(jsonResponse({ ...bootstrapBody, relayVersion: "0.9.0" }));
    resolvers[1]?.(jsonResponse(bootstrapBody));
    await vi.waitFor(() => expect(onAdmission).toHaveBeenCalledTimes(1));
    expect(onAdmission).toHaveBeenCalledWith({
      direction: ProxyProtocolAdmissionDirection.COMPATIBLE,
      relayVersion: "0.9.1",
      relayControlProtocolVersion: 1,
    });
    monitor.dispose();
  });

  it("stops retrying as soon as the WebSocket control protocol connects", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      });
      const monitor = createRelayUpgradeBootstrapMonitor({
        relayUrl: "ws://127.0.0.1:3100",
        logger: testLogger(),
        onAdmission: vi.fn(),
        fetchImpl,
        retryInitialMs: 5,
        retryMaxMs: 5,
      });

      monitor.request();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      monitor.markControlProtocolConnected();
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      monitor.request();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
