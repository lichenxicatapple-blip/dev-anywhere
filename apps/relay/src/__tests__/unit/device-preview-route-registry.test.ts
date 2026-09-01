import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { DevicePreviewRouteRegistry } from "#src/device-preview-route-registry.js";

function socket(): WebSocket {
  return {} as WebSocket;
}

function upstreamIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error("Missing deterministic upstream requestId");
    return id;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DevicePreviewRouteRegistry", () => {
  it("isolates colliding browser request IDs by rewriting and exact-socket routing", () => {
    const routes = new DevicePreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("device-up-a", "device-up-b"),
    });
    const clientA = socket();
    const clientB = socket();
    const proxy = socket();

    expect(routes.register("p1", "same", "device_preview_create_response", clientA, proxy)).toEqual(
      { kind: "registered", upstreamRequestId: "device-up-a" },
    );
    expect(routes.register("p1", "same", "device_preview_create_response", clientB, proxy)).toEqual(
      { kind: "registered", upstreamRequestId: "device-up-b" },
    );

    expect(routes.resolve("p1", "device-up-b", "device_preview_create_response", proxy)).toEqual({
      kind: "matched",
      clientWs: clientB,
      clientRequestId: "same",
    });
    expect(routes.resolve("p1", "device-up-a", "device_preview_create_response", proxy)).toEqual({
      kind: "matched",
      clientWs: clientA,
      clientRequestId: "same",
    });
    routes.dispose();
  });

  it("does not consume a route for the wrong response type or stale Proxy socket", () => {
    const routes = new DevicePreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("device-list"),
    });
    const client = socket();
    const currentProxy = socket();
    const staleProxy = socket();
    routes.register("p1", "list-client", "device_preview_list_response", client, currentProxy);

    expect(
      routes.resolve("p1", "device-list", "device_preview_close_response", currentProxy),
    ).toEqual({
      kind: "response_type_mismatch",
      expectedResponseType: "device_preview_list_response",
    });
    expect(routes.resolve("p1", "device-list", "device_preview_list_response", staleProxy)).toEqual(
      { kind: "stale_proxy" },
    );
    expect(
      routes.resolve("p1", "device-list", "device_preview_list_response", currentProxy),
    ).toEqual({ kind: "matched", clientWs: client, clientRequestId: "list-client" });
    routes.dispose();
  });

  it("tombstones abandoned and timed-out requests, then bounds capacity", () => {
    vi.useFakeTimers();
    const routes = new DevicePreviewRouteRegistry({
      maxEntries: 2,
      maxPendingPerClient: 1,
      pendingTtlMs: 10,
      tombstoneTtlMs: 5,
      upstreamRequestIdFactory: upstreamIds("one", "two", "three"),
    });
    const client = socket();
    const other = socket();
    const proxy = socket();

    expect(routes.register("p1", "one", "device_preview_list_response", client, proxy).kind).toBe(
      "registered",
    );
    expect(
      routes.register("p1", "overflow", "device_preview_list_response", client, proxy),
    ).toEqual({ kind: "client_capacity_exceeded" });
    routes.abandonSocket(client);
    expect(routes.resolve("p1", "one", "device_preview_list_response", proxy)).toEqual({
      kind: "tombstone",
    });

    expect(routes.register("p1", "two", "device_preview_close_response", other, proxy).kind).toBe(
      "registered",
    );
    vi.advanceTimersByTime(10);
    expect(routes.resolve("p1", "two", "device_preview_close_response", proxy)).toEqual({
      kind: "tombstone",
    });
    vi.advanceTimersByTime(5);
    expect(routes.resolve("p1", "two", "device_preview_close_response", proxy)).toEqual({
      kind: "unmatched",
    });
    routes.dispose();
  });
});
