import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
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
    const onVersion = vi.fn();
    const monitor = createRelayUpgradeBootstrapMonitor({
      relayUrl: "ws://127.0.0.1:3100",
      logger: testLogger(),
      onVersion,
      fetchImpl,
    });

    monitor.request();
    monitor.request();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(bootstrapBody));
    await vi.waitFor(() => expect(onVersion).toHaveBeenCalledWith("0.9.1"));
    expect(onVersion).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("retries a transient failure until version discovery succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(jsonResponse(bootstrapBody));
    const onVersion = vi.fn();
    const monitor = createRelayUpgradeBootstrapMonitor({
      relayUrl: "ws://127.0.0.1:3100",
      logger: testLogger(),
      onVersion,
      fetchImpl,
      retryInitialMs: 1,
      retryMaxMs: 1,
    });

    monitor.request();
    await vi.waitFor(() => expect(onVersion).toHaveBeenCalledWith("0.9.1"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
        onVersion: vi.fn(),
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
