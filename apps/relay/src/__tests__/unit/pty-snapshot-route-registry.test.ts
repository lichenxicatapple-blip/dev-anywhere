import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { PtySnapshotRouteRegistry } from "#src/pty-snapshot-route-registry.js";

function socket(): WebSocket {
  return {} as WebSocket;
}

describe("PtySnapshotRouteRegistry", () => {
  it("resolves a pending route to the exact requesting socket once", () => {
    const routes = new PtySnapshotRouteRegistry();
    const client = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("registered");
    expect(routes.resolve("p1", "s1", "r1", proxy)).toEqual({
      kind: "matched",
      clientWs: client,
    });
    expect(routes.resolve("p1", "s1", "r1", proxy)).toEqual({ kind: "tombstone" });
  });

  it("deduplicates the same socket without allowing a collision to replace it", () => {
    const routes = new PtySnapshotRouteRegistry();
    const owner = socket();
    const colliding = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "r1", owner, proxy)).toBe("registered");
    expect(routes.register("p1", "s1", "r1", owner, proxy)).toBe("duplicate");
    expect(routes.register("p1", "s1", "r1", colliding, proxy)).toBe("collision");
    expect(routes.resolve("p1", "s1", "r1", proxy)).toEqual({
      kind: "matched",
      clientWs: owner,
    });
  });

  it("turns disconnected socket routes into tombstones", () => {
    const routes = new PtySnapshotRouteRegistry();
    const abandoned = socket();
    const proxy = socket();

    routes.register("p1", "s1", "r1", abandoned, proxy);
    routes.abandonSocket(abandoned);

    expect(routes.resolve("p1", "s1", "r1", proxy)).toEqual({ kind: "tombstone" });
  });

  it("does not extend the pending TTL for a same-socket retry", () => {
    let now = 0;
    const routes = new PtySnapshotRouteRegistry({ pendingTtlMs: 10, now: () => now });
    const client = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("registered");
    now = 9;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("duplicate");
    now = 10;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("registered");
  });

  it("makes an unanswered same-socket retry due at 25s intervals without extending its TTL", () => {
    let now = 0;
    const routes = new PtySnapshotRouteRegistry({
      now: () => now,
    });
    const client = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("registered");
    now = 24_999;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("duplicate");
    now = 25_000;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("retry_due");
    now = 49_999;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("duplicate");
    now = 50_000;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("retry_due");
    now = 299_999;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("retry_due");

    now = 300_000;
    expect(routes.register("p1", "s1", "r1", client, proxy)).toBe("registered");
  });

  it("allows a retry after proxy reconnect without letting the old socket consume it", () => {
    const routes = new PtySnapshotRouteRegistry();
    const client = socket();
    const oldProxy = socket();
    const newProxy = socket();

    expect(routes.register("p1", "s1", "r1", client, oldProxy)).toBe("registered");
    routes.clearProxy("p1");
    expect(routes.register("p1", "s1", "r1", client, newProxy)).toBe("registered");
    expect(routes.resolve("p1", "s1", "r1", oldProxy)).toEqual({ kind: "stale_proxy" });
    expect(routes.resolve("p1", "s1", "r1", newProxy)).toEqual({
      kind: "matched",
      clientWs: client,
    });
  });

  it("matches the complete proxy, session, and request tuple", () => {
    const routes = new PtySnapshotRouteRegistry();
    const client = socket();
    const proxy = socket();
    routes.register("p1", "s1", "r1", client, proxy);

    expect(routes.resolve("p2", "s1", "r1", proxy)).toEqual({ kind: "unmatched" });
    expect(routes.resolve("p1", "s2", "r1", proxy)).toEqual({ kind: "unmatched" });
    expect(routes.resolve("p1", "s1", "r2", proxy)).toEqual({ kind: "unmatched" });
    expect(routes.resolve("p1", "s1", "r1", proxy)).toEqual({
      kind: "matched",
      clientWs: client,
    });
  });

  it("bounds capacity and releases expired pending and tombstone entries", () => {
    let now = 0;
    const routes = new PtySnapshotRouteRegistry({
      maxEntries: 1,
      pendingTtlMs: 10,
      tombstoneTtlMs: 5,
      now: () => now,
    });
    const first = socket();
    const second = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "r1", first, proxy)).toBe("registered");
    expect(routes.register("p1", "s1", "r2", second, proxy)).toBe("capacity_exceeded");

    now = 10;
    expect(routes.register("p1", "s1", "r2", second, proxy)).toBe("registered");
    expect(routes.resolve("p1", "s1", "r2", proxy)).toEqual({
      kind: "matched",
      clientWs: second,
    });
    expect(routes.register("p1", "s1", "r2", first, proxy)).toBe("collision");

    now = 15;
    expect(routes.register("p1", "s1", "r2", first, proxy)).toBe("registered");
  });

  it("prevents one client socket from consuming the global pending-route capacity", () => {
    const routes = new PtySnapshotRouteRegistry({
      maxEntries: 4,
      maxPendingPerClient: 2,
    });
    const noisyClient = socket();
    const otherClient = socket();
    const proxy = socket();

    expect(routes.register("p1", "s1", "noisy-1", noisyClient, proxy)).toBe("registered");
    expect(routes.register("p1", "s1", "noisy-2", noisyClient, proxy)).toBe("registered");
    expect(routes.register("p1", "s1", "noisy-3", noisyClient, proxy)).toBe(
      "client_capacity_exceeded",
    );
    expect(routes.register("p1", "s1", "other-1", otherClient, proxy)).toBe("registered");
  });

  it("evicts the oldest tombstone before rejecting a new live request", () => {
    let now = 0;
    const routes = new PtySnapshotRouteRegistry({
      maxEntries: 2,
      tombstoneTtlMs: 100,
      now: () => now,
    });
    const client = socket();
    const proxy = socket();

    routes.register("p1", "s1", "done-oldest", client, proxy);
    routes.resolve("p1", "s1", "done-oldest", proxy);
    now = 1;
    routes.register("p1", "s1", "done-newer", client, proxy);
    routes.resolve("p1", "s1", "done-newer", proxy);

    expect(routes.register("p1", "s1", "live", client, proxy)).toBe("registered");
    expect(routes.resolve("p1", "s1", "done-oldest", proxy)).toEqual({ kind: "unmatched" });
    expect(routes.resolve("p1", "s1", "done-newer", proxy)).toEqual({ kind: "tombstone" });
    expect(routes.resolve("p1", "s1", "live", proxy)).toEqual({
      kind: "matched",
      clientWs: client,
    });
  });
});
