import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_HEALTH_HEADER,
  PREVIEW_HEALTH_MARKER,
  probePreviewTunnelEdge,
  waitForQuickTunnelReachability,
} from "#src/common/quick-tunnel-readiness.js";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: requestMock }));

const PUBLIC_URL = "https://dns-delayed.trycloudflare.com";

afterEach(() => requestMock.mockReset());

describe("Quick Tunnel public reachability", () => {
  it("waits through authoritative NXDOMAIN and HTTP 530 before succeeding", async () => {
    const resolveEdgeAddresses = vi
      .fn<(hostname: string, signal: AbortSignal) => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(["104.16.230.132"]);
    const probeEdgeAddress = vi
      .fn<(hostname: string, address: string, signal: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      waitForQuickTunnelReachability({
        publicUrl: PUBLIC_URL,
        signal: new AbortController().signal,
        timeoutMs: 100,
        retryIntervalMs: 1,
        resolveEdgeAddresses,
        probeEdgeAddress,
      }),
    ).resolves.toBeUndefined();
    expect(resolveEdgeAddresses).toHaveBeenCalledTimes(3);
    expect(probeEdgeAddress).toHaveBeenCalledTimes(2);
    expect(probeEdgeAddress).toHaveBeenLastCalledWith(
      "dns-delayed.trycloudflare.com",
      "104.16.230.132",
      expect.any(AbortSignal),
    );
  });

  it("times out without exposing the generated hostname", async () => {
    await expect(
      waitForQuickTunnelReachability({
        publicUrl: PUBLIC_URL,
        signal: new AbortController().signal,
        timeoutMs: 5,
        retryIntervalMs: 1,
        resolveEdgeAddresses: vi.fn(async () => []),
      }),
    ).rejects.toThrow("Quick Tunnel did not become reachable within 0.005s");
    await expect(
      waitForQuickTunnelReachability({
        publicUrl: PUBLIC_URL,
        signal: new AbortController().signal,
        timeoutMs: 1,
        resolveEdgeAddresses: vi.fn(async () => []),
      }),
    ).rejects.not.toThrow("dns-delayed");
  });

  it("cancels a pending retry immediately", async () => {
    const controller = new AbortController();
    const readiness = waitForQuickTunnelReachability({
      publicUrl: PUBLIC_URL,
      signal: controller.signal,
      timeoutMs: 60_000,
      retryIntervalMs: 60_000,
      resolveEdgeAddresses: vi.fn(async () => []),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(readiness).rejects.toThrow("Quick Tunnel readiness cancelled");
  });

  it("rejects non-trycloudflare URLs before resolving DNS", async () => {
    const resolveEdgeAddresses = vi.fn(async () => ["127.0.0.1"]);
    await expect(
      waitForQuickTunnelReachability({
        publicUrl: "https://example.com",
        signal: new AbortController().signal,
        resolveEdgeAddresses,
      }),
    ).rejects.toThrow("invalid Quick Tunnel URL");
    expect(resolveEdgeAddresses).not.toHaveBeenCalled();
  });

  it("supplies a fixed address in Node's all-address lookup mode", async () => {
    let lookupResult: unknown;
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error: Error) => void;
    };
    request.end = vi.fn();
    request.destroy = (error) => request.emit("error", error);
    requestMock.mockReturnValue(request);

    const probe = probePreviewTunnelEdge(
      "fixed-edge.trycloudflare.com",
      "104.16.230.132",
      new AbortController().signal,
    );
    const requestOptions = requestMock.mock.calls[0]?.[0] as {
      lookup: (
        hostname: string,
        options: { all: boolean },
        callback: (error: Error | null, addresses: unknown) => void,
      ) => void;
    };
    requestOptions.lookup("fixed-edge.trycloudflare.com", { all: true }, (_error, addresses) => {
      lookupResult = addresses;
    });
    expect(lookupResult).toEqual([{ address: "104.16.230.132", family: 4 }]);

    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      resume: () => void;
    };
    response.statusCode = 204;
    response.headers = { [PREVIEW_HEALTH_HEADER]: PREVIEW_HEALTH_MARKER };
    response.resume = vi.fn();
    request.emit("response", response);
    response.emit("end");
    await expect(probe).resolves.toBe(true);
  });
});
