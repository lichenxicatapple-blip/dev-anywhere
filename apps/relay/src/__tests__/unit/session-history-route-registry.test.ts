import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { SessionHistoryRouteRegistry } from "#src/session-history-route-registry.js";

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

describe("SessionHistoryRouteRegistry", () => {
  it("fans a 35-page refresh storm into one upstream flight", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-storm"),
    });
    const proxy = socket();
    const clients = Array.from({ length: 35 }, () => socket());

    const registrations = clients.map((client, index) =>
      routes.register("p1", `refresh-${index}`, client, proxy),
    );

    expect(registrations.filter((registration) => registration.kind === "leader")).toHaveLength(1);
    expect(registrations.filter((registration) => registration.kind === "joined")).toHaveLength(34);
    const resolution = routes.resolve("p1", "upstream-storm", proxy);
    expect(resolution.kind).toBe("matched");
    if (resolution.kind === "matched") {
      expect(resolution.targets).toHaveLength(35);
      expect(new Set(resolution.targets.map((target) => target.requestId))).toEqual(
        new Set(Array.from({ length: 35 }, (_, index) => `refresh-${index}`)),
      );
    }
  });

  it("fans one upstream flight out to every exact waiter", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-1"),
    });
    const clientA = socket();
    const clientB = socket();
    const proxy = socket();

    expect(routes.register("p1", "history-a", clientA, proxy)).toEqual({
      kind: "leader",
      upstreamRequestId: "upstream-1",
    });
    expect(routes.register("p1", "history-b", clientB, proxy)).toEqual({
      kind: "joined",
      upstreamRequestId: "upstream-1",
    });
    expect(routes.resolve("p1", "upstream-1", proxy)).toEqual({
      kind: "matched",
      targets: [
        { clientWs: clientA, requestId: "history-a" },
        { clientWs: clientB, requestId: "history-b" },
      ],
    });
    expect(routes.resolve("p1", "upstream-1", proxy)).toEqual({ kind: "tombstone" });
  });

  it("keeps followers alive when the leader client disconnects", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-1"),
    });
    const leader = socket();
    const follower = socket();
    const proxy = socket();

    routes.register("p1", "leader", leader, proxy);
    routes.register("p1", "follower", follower, proxy);
    routes.abandonSocket(leader);

    expect(routes.resolve("p1", "upstream-1", proxy)).toEqual({
      kind: "matched",
      targets: [{ clientWs: follower, requestId: "follower" }],
    });
  });

  it("consumes a response with no targets after every waiter disconnects", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-1"),
    });
    const client = socket();
    const proxy = socket();

    routes.register("p1", "abandoned", client, proxy);
    routes.abandonSocket(client);

    expect(routes.resolve("p1", "upstream-1", proxy)).toEqual({
      kind: "matched",
      targets: [],
    });
    expect(routes.resolve("p1", "upstream-1", proxy)).toEqual({ kind: "tombstone" });
  });

  it("suppresses a same-socket duplicate and rejects a cross-client collision", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-1"),
    });
    const owner = socket();
    const colliding = socket();
    const proxy = socket();

    expect(routes.register("p1", "same-id", owner, proxy).kind).toBe("leader");
    expect(routes.register("p1", "same-id", owner, proxy)).toEqual({ kind: "duplicate" });
    expect(routes.register("p1", "same-id", colliding, proxy)).toEqual({ kind: "collision" });
  });

  it("rotates an old flight so a Web retry is forwarded instead of swallowed", () => {
    let now = 0;
    const routes = new SessionHistoryRouteRegistry({
      pendingTtlMs: 30,
      joinWindowMs: 10,
      now: () => now,
      upstreamRequestIdFactory: upstreamIds("upstream-old", "upstream-retry"),
    });
    const initialClient = socket();
    const retryClient = socket();
    const proxy = socket();

    expect(routes.register("p1", "initial", initialClient, proxy).kind).toBe("leader");
    now = 10;
    expect(routes.register("p1", "retry", retryClient, proxy)).toEqual({
      kind: "leader",
      upstreamRequestId: "upstream-retry",
    });

    expect(routes.resolve("p1", "upstream-old", proxy)).toEqual({ kind: "tombstone" });
    expect(routes.resolve("p1", "upstream-retry", proxy)).toEqual({
      kind: "matched",
      targets: [
        { clientWs: initialClient, requestId: "initial" },
        { clientWs: retryClient, requestId: "retry" },
      ],
    });
  });

  it("drops an expired flight and starts a clean replacement", () => {
    let now = 0;
    const routes = new SessionHistoryRouteRegistry({
      pendingTtlMs: 10,
      joinWindowMs: 5,
      now: () => now,
      upstreamRequestIdFactory: upstreamIds("upstream-old", "upstream-new"),
    });
    const oldClient = socket();
    const newClient = socket();
    const proxy = socket();

    routes.register("p1", "expired", oldClient, proxy);
    now = 11;
    expect(routes.register("p1", "fresh", newClient, proxy)).toEqual({
      kind: "leader",
      upstreamRequestId: "upstream-new",
    });
    expect(routes.resolve("p1", "upstream-old", proxy)).toEqual({ kind: "tombstone" });
    expect(routes.resolve("p1", "upstream-new", proxy)).toEqual({
      kind: "matched",
      targets: [{ clientWs: newClient, requestId: "fresh" }],
    });
  });

  it("clears old flights on reconnect and rejects the stale proxy socket", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("same-upstream", "same-upstream"),
    });
    const client = socket();
    const oldProxy = socket();
    const newProxy = socket();

    routes.register("p1", "before-reconnect", client, oldProxy);
    routes.clearProxy("p1");
    routes.register("p1", "after-reconnect", client, newProxy);

    expect(routes.resolve("p1", "same-upstream", oldProxy)).toEqual({ kind: "stale_proxy" });
    expect(routes.resolve("p1", "same-upstream", newProxy)).toEqual({
      kind: "matched",
      targets: [{ clientWs: client, requestId: "after-reconnect" }],
    });
  });

  it("keeps flights independent across proxies", () => {
    const routes = new SessionHistoryRouteRegistry({
      upstreamRequestIdFactory: upstreamIds("upstream-p1", "upstream-p2"),
    });
    const client1 = socket();
    const client2 = socket();
    const proxy1 = socket();
    const proxy2 = socket();

    expect(routes.register("p1", "history-1", client1, proxy1).kind).toBe("leader");
    expect(routes.register("p2", "history-2", client2, proxy2).kind).toBe("leader");
    expect(routes.resolve("p2", "upstream-p2", proxy2)).toEqual({
      kind: "matched",
      targets: [{ clientWs: client2, requestId: "history-2" }],
    });
    expect(routes.resolve("p1", "upstream-p1", proxy1)).toEqual({
      kind: "matched",
      targets: [{ clientWs: client1, requestId: "history-1" }],
    });
  });

  it("drops unmatched responses", () => {
    const routes = new SessionHistoryRouteRegistry();
    expect(routes.resolve("p1", "missing", socket())).toEqual({ kind: "unmatched" });
  });

  it("bounds global and per-client pending capacity", () => {
    const routes = new SessionHistoryRouteRegistry({
      maxEntries: 3,
      maxPendingPerClient: 2,
      upstreamRequestIdFactory: upstreamIds("upstream-1"),
    });
    const noisyClient = socket();
    const otherClient = socket();
    const proxy = socket();

    expect(routes.register("p1", "noisy-1", noisyClient, proxy).kind).toBe("leader");
    expect(routes.register("p1", "noisy-2", noisyClient, proxy).kind).toBe("joined");
    expect(routes.register("p1", "noisy-3", noisyClient, proxy)).toEqual({
      kind: "client_capacity_exceeded",
    });
    expect(routes.register("p1", "other-1", otherClient, proxy).kind).toBe("joined");
    expect(routes.register("p1", "other-2", otherClient, proxy)).toEqual({
      kind: "capacity_exceeded",
    });
  });
});
