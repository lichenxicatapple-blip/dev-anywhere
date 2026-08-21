import type { WebSocket } from "ws";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_PER_CLIENT = 64;
// Keep this below the browser's 30s delivery retry. A small scheduling/network delay must not
// suppress the first retry and postpone recovery until the following 60s attempt.
const DEFAULT_RETRY_FORWARD_INTERVAL_MS = 25_000;
const DEFAULT_PENDING_TTL_MS = 5 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 120_000;

type PendingRoute = {
  state: "pending";
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  lastForwardedAt: number;
  expiresAt: number;
};

type TombstoneRoute = {
  state: "tombstone";
  proxyId: string;
  expiresAt: number;
};

type SnapshotRoute = PendingRoute | TombstoneRoute;

export type SnapshotRouteRegistration =
  | "registered"
  | "duplicate"
  | "retry_due"
  | "collision"
  | "client_capacity_exceeded"
  | "capacity_exceeded";

export type SnapshotRouteResolution =
  | { kind: "matched"; clientWs: WebSocket }
  | { kind: "stale_proxy" }
  | { kind: "tombstone" }
  | { kind: "unmatched" };

export interface PtySnapshotRouteRegistryOptions {
  maxEntries?: number;
  maxPendingPerClient?: number;
  retryForwardIntervalMs?: number;
  pendingTtlMs?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
}

function routeKey(proxyId: string, sessionId: string, requestId: string): string {
  return JSON.stringify([proxyId, sessionId, requestId]);
}

/**
 * Correlates a request-scoped PTY snapshot with the exact browser socket that requested it.
 * Entries are capacity- and TTL-bounded; tombstones retain no socket reference and ensure a
 * response arriving after disconnect is dropped rather than falling back to a broadcast.
 */
export class PtySnapshotRouteRegistry {
  private readonly routes = new Map<string, SnapshotRoute>();
  private readonly maxEntries: number;
  private readonly maxPendingPerClient: number;
  private readonly retryForwardIntervalMs: number;
  private readonly pendingTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;

  constructor(options: PtySnapshotRouteRegistryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxPendingPerClient = Math.max(
      1,
      options.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT,
    );
    this.retryForwardIntervalMs = Math.max(
      1,
      options.retryForwardIntervalMs ?? DEFAULT_RETRY_FORWARD_INTERVAL_MS,
    );
    this.pendingTtlMs = Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
    this.tombstoneTtlMs = Math.max(1, options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  register(
    proxyId: string,
    sessionId: string,
    requestId: string,
    clientWs: WebSocket,
    proxyWs: WebSocket,
  ): SnapshotRouteRegistration {
    const now = this.now();
    this.pruneExpired(now);
    const key = routeKey(proxyId, sessionId, requestId);
    const existing = this.routes.get(key);
    if (existing) {
      if (
        existing.state === "pending" &&
        existing.clientWs === clientWs &&
        existing.proxyWs === proxyWs
      ) {
        if (now - existing.lastForwardedAt >= this.retryForwardIntervalMs) {
          existing.lastForwardedAt = now;
          return "retry_due";
        }
        return "duplicate";
      }
      return "collision";
    }
    let clientPendingCount = 0;
    for (const route of this.routes.values()) {
      if (route.state === "pending" && route.clientWs === clientWs) {
        clientPendingCount += 1;
        if (clientPendingCount >= this.maxPendingPerClient) {
          return "client_capacity_exceeded";
        }
      }
    }
    if (this.routes.size >= this.maxEntries) {
      let oldestTombstoneKey: string | undefined;
      let oldestTombstoneExpiry = Number.POSITIVE_INFINITY;
      for (const [candidateKey, route] of this.routes) {
        if (route.state === "tombstone" && route.expiresAt < oldestTombstoneExpiry) {
          oldestTombstoneKey = candidateKey;
          oldestTombstoneExpiry = route.expiresAt;
        }
      }
      if (oldestTombstoneKey) this.routes.delete(oldestTombstoneKey);
      else return "capacity_exceeded";
    }

    this.routes.set(key, {
      state: "pending",
      proxyId,
      proxyWs,
      clientWs,
      lastForwardedAt: now,
      expiresAt: now + this.pendingTtlMs,
    });
    return "registered";
  }

  resolve(
    proxyId: string,
    sessionId: string,
    requestId: string,
    proxyWs: WebSocket,
  ): SnapshotRouteResolution {
    const now = this.now();
    this.pruneExpired(now);
    const key = routeKey(proxyId, sessionId, requestId);
    const route = this.routes.get(key);
    if (!route) return { kind: "unmatched" };
    if (route.state === "tombstone") return { kind: "tombstone" };
    if (route.proxyWs !== proxyWs) return { kind: "stale_proxy" };

    this.routes.set(key, {
      state: "tombstone",
      proxyId,
      expiresAt: now + this.tombstoneTtlMs,
    });
    return { kind: "matched", clientWs: route.clientWs };
  }

  abandonSocket(clientWs: WebSocket): void {
    const now = this.now();
    this.pruneExpired(now);
    for (const [key, route] of this.routes) {
      if (route.state === "pending" && route.clientWs === clientWs) {
        this.routes.set(key, {
          state: "tombstone",
          proxyId: route.proxyId,
          expiresAt: now + this.tombstoneTtlMs,
        });
      }
    }
  }

  clearProxy(proxyId: string): void {
    for (const [key, route] of this.routes) {
      if (route.proxyId === proxyId) this.routes.delete(key);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, route] of this.routes) {
      if (route.expiresAt <= now) this.routes.delete(key);
    }
  }
}
