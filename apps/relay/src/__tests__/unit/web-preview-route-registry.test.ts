import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebPreviewRouteRegistry } from "#src/web-preview-route-registry.js";

function socket(): WebSocket {
  return {} as WebSocket;
}

function upstreamIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error("Missing deterministic upstream requestId");
    return id;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebPreviewRouteRegistry", () => {
  it("rewrites equal client request IDs and resolves each response to its exact socket", () => {
    const routes = new WebPreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-a", "upstream-b"),
    });
    const clientA = socket();
    const clientB = socket();
    const proxy = socket();

    expect(
      routes.register("p1", "same-client-id", "preview_create_response", clientA, proxy),
    ).toEqual({ kind: "registered", upstreamRequestId: "upstream-a" });
    expect(
      routes.register("p1", "same-client-id", "preview_create_response", clientB, proxy),
    ).toEqual({ kind: "registered", upstreamRequestId: "upstream-b" });

    expect(routes.resolve("p1", "upstream-b", "preview_create_response", proxy)).toEqual({
      kind: "matched",
      clientWs: clientB,
      clientRequestId: "same-client-id",
    });
    expect(routes.resolve("p1", "upstream-a", "preview_create_response", proxy)).toEqual({
      kind: "matched",
      clientWs: clientA,
      clientRequestId: "same-client-id",
    });
    routes.dispose();
  });

  it("does not let a wrong response type consume the pending route", () => {
    const routes = new WebPreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-list"),
    });
    const client = socket();
    const proxy = socket();
    routes.register("p1", "list-client", "preview_list_response", client, proxy);

    expect(routes.resolve("p1", "upstream-list", "preview_close_response", proxy)).toEqual({
      kind: "response_type_mismatch",
      expectedResponseType: "preview_list_response",
    });
    expect(routes.resolve("p1", "upstream-list", "preview_list_response", proxy)).toEqual({
      kind: "matched",
      clientWs: client,
      clientRequestId: "list-client",
    });
    routes.dispose();
  });

  it("rejects an old Proxy socket after reconnect", () => {
    const routes = new WebPreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("before", "after"),
    });
    const client = socket();
    const oldProxy = socket();
    const newProxy = socket();

    routes.register("p1", "old", "preview_list_response", client, oldProxy);
    routes.clearProxy("p1");
    routes.register("p1", "new", "preview_list_response", client, newProxy);

    expect(routes.resolve("p1", "after", "preview_list_response", oldProxy)).toEqual({
      kind: "stale_proxy",
    });
    expect(routes.resolve("p1", "after", "preview_list_response", newProxy)).toEqual({
      kind: "matched",
      clientWs: client,
      clientRequestId: "new",
    });
    routes.dispose();
  });

  it("turns disconnected client routes into socket-free tombstones", () => {
    const routes = new WebPreviewRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("abandoned"),
    });
    const client = socket();
    const proxy = socket();
    routes.register("p1", "client-request", "preview_close_response", client, proxy);

    routes.abandonSocket(client);

    expect(routes.resolve("p1", "abandoned", "preview_close_response", proxy)).toEqual({
      kind: "tombstone",
    });
    routes.dispose();
  });

  it("expires pending routes on a real timer and later removes their tombstones", () => {
    vi.useFakeTimers();
    const routes = new WebPreviewRouteRegistry({
      pendingTtlMs: 10,
      tombstoneTtlMs: 5,
      upstreamRequestIdFactory: upstreamIds("timed"),
    });
    const client = socket();
    const proxy = socket();
    routes.register("p1", "client-request", "preview_list_response", client, proxy);

    vi.advanceTimersByTime(10);
    expect(routes.resolve("p1", "timed", "preview_list_response", proxy)).toEqual({
      kind: "tombstone",
    });
    vi.advanceTimersByTime(5);
    expect(routes.resolve("p1", "timed", "preview_list_response", proxy)).toEqual({
      kind: "unmatched",
    });
    routes.dispose();
  });

  it("bounds per-client and global pending capacity", () => {
    const routes = new WebPreviewRouteRegistry({
      maxEntries: 3,
      maxPendingPerClient: 2,
      upstreamRequestIdFactory: upstreamIds("one", "two", "three"),
    });
    const noisyClient = socket();
    const otherClient = socket();
    const proxy = socket();

    expect(routes.register("p1", "one", "preview_list_response", noisyClient, proxy).kind).toBe(
      "registered",
    );
    expect(routes.register("p1", "two", "preview_list_response", noisyClient, proxy).kind).toBe(
      "registered",
    );
    expect(routes.register("p1", "three", "preview_list_response", noisyClient, proxy)).toEqual({
      kind: "client_capacity_exceeded",
    });
    expect(routes.register("p1", "other", "preview_list_response", otherClient, proxy).kind).toBe(
      "registered",
    );
    expect(routes.register("p1", "overflow", "preview_list_response", socket(), proxy)).toEqual({
      kind: "capacity_exceeded",
    });
    routes.dispose();
  });
});
