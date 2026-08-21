import { nanoid } from "nanoid";
import type { WebSocket } from "ws";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_PER_CLIENT = 64;
const DEFAULT_PENDING_TTL_MS = 20_000;
const DEFAULT_JOIN_WINDOW_MS = 8_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;

type PendingRoute = {
  state: "pending";
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  upstreamRequestId: string;
  expiresAt: number;
};

type TombstoneRoute = {
  state: "tombstone";
  proxyId: string;
  expiresAt: number;
};

type HistoryRoute = PendingRoute | TombstoneRoute;

type HistoryFlight = {
  proxyId: string;
  proxyWs: WebSocket;
  upstreamRequestId: string;
  requestIds: Set<string>;
  joinUntil: number;
  expiresAt: number;
};

type FlightTombstone = {
  proxyId: string;
  expiresAt: number;
};

export type HistoryRouteRegistration =
  | { kind: "leader"; upstreamRequestId: string }
  | { kind: "joined"; upstreamRequestId: string }
  | { kind: "duplicate" }
  | { kind: "collision" }
  | { kind: "client_capacity_exceeded" }
  | { kind: "capacity_exceeded" };

export type HistoryRouteTarget = {
  clientWs: WebSocket;
  requestId: string;
};

export type HistoryRouteResolution =
  | { kind: "matched"; targets: HistoryRouteTarget[] }
  | { kind: "stale_proxy" }
  | { kind: "tombstone" }
  | { kind: "unmatched" };

export interface SessionHistoryRouteRegistryOptions {
  maxEntries?: number;
  maxPendingPerClient?: number;
  pendingTtlMs?: number;
  joinWindowMs?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
  upstreamRequestIdFactory?: () => string;
}

function routeKey(proxyId: string, requestId: string): string {
  return JSON.stringify([proxyId, requestId]);
}

/**
 * Coalesces overlapping history requests for the same live proxy socket and correlates the one
 * upstream response with every exact browser waiter. External request IDs never cross the proxy
 * wire: a relay-owned ID prevents a late response from being confused with a reused client ID.
 */
export class SessionHistoryRouteRegistry {
  private readonly routes = new Map<string, HistoryRoute>();
  private readonly flights = new Map<string, HistoryFlight>();
  private readonly flightTombstones = new Map<string, FlightTombstone>();
  private readonly maxEntries: number;
  private readonly maxPendingPerClient: number;
  private readonly pendingTtlMs: number;
  private readonly joinWindowMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;
  private readonly upstreamRequestIdFactory: () => string;
  private upstreamRequestSequence = 0;

  constructor(options: SessionHistoryRouteRegistryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxPendingPerClient = Math.max(
      1,
      options.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT,
    );
    this.pendingTtlMs = Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
    this.joinWindowMs = Math.max(
      1,
      Math.min(options.joinWindowMs ?? DEFAULT_JOIN_WINDOW_MS, this.pendingTtlMs),
    );
    this.tombstoneTtlMs = Math.max(1, options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.upstreamRequestIdFactory =
      options.upstreamRequestIdFactory ??
      (() => {
        this.upstreamRequestSequence += 1;
        return `relay-history-${this.upstreamRequestSequence.toString(36)}-${nanoid(12)}`;
      });
  }

  register(
    proxyId: string,
    requestId: string,
    clientWs: WebSocket,
    proxyWs: WebSocket,
  ): HistoryRouteRegistration {
    const now = this.now();
    this.pruneExpired(now);
    const key = routeKey(proxyId, requestId);
    const existing = this.routes.get(key);
    if (existing) {
      if (
        existing.state === "pending" &&
        existing.clientWs === clientWs &&
        existing.proxyWs === proxyWs
      ) {
        return { kind: "duplicate" };
      }
      return { kind: "collision" };
    }

    let clientPendingCount = 0;
    for (const route of this.routes.values()) {
      if (route.state === "pending" && route.clientWs === clientWs) {
        clientPendingCount += 1;
        if (clientPendingCount >= this.maxPendingPerClient) {
          return { kind: "client_capacity_exceeded" };
        }
      }
    }

    if (this.routes.size >= this.maxEntries && !this.evictOldestRouteTombstone()) {
      return { kind: "capacity_exceeded" };
    }

    let flight = this.flights.get(proxyId);
    if (flight && flight.proxyWs !== proxyWs) {
      this.expireFlight(flight, now);
      flight = undefined;
    }

    let kind: "leader" | "joined";
    if (!flight || flight.joinUntil <= now) {
      const replacement = this.createFlight(proxyId, proxyWs, now);
      if (flight) this.migrateFlight(flight, replacement, now);
      this.flights.set(proxyId, replacement);
      flight = replacement;
      kind = "leader";
    } else {
      kind = "joined";
    }

    const routeExpiresAt = now + this.pendingTtlMs;
    flight.requestIds.add(requestId);
    flight.expiresAt = Math.max(flight.expiresAt, routeExpiresAt);
    this.routes.set(key, {
      state: "pending",
      proxyId,
      proxyWs,
      clientWs,
      upstreamRequestId: flight.upstreamRequestId,
      expiresAt: routeExpiresAt,
    });
    return { kind, upstreamRequestId: flight.upstreamRequestId };
  }

  resolve(proxyId: string, requestId: string, proxyWs: WebSocket): HistoryRouteResolution {
    const now = this.now();
    this.pruneExpired(now);
    const flight = this.flights.get(proxyId);
    if (!flight || flight.upstreamRequestId !== requestId) {
      return this.flightTombstones.has(routeKey(proxyId, requestId))
        ? { kind: "tombstone" }
        : { kind: "unmatched" };
    }
    if (flight.proxyWs !== proxyWs) return { kind: "stale_proxy" };

    this.flights.delete(proxyId);
    this.setFlightTombstone(flight, now);

    const targets: HistoryRouteTarget[] = [];
    for (const externalRequestId of flight.requestIds) {
      const key = routeKey(proxyId, externalRequestId);
      const route = this.routes.get(key);
      if (
        !route ||
        route.state !== "pending" ||
        route.proxyWs !== proxyWs ||
        route.upstreamRequestId !== requestId
      ) {
        continue;
      }
      this.routes.set(key, {
        state: "tombstone",
        proxyId,
        expiresAt: now + this.tombstoneTtlMs,
      });
      targets.push({ clientWs: route.clientWs, requestId: externalRequestId });
    }
    return { kind: "matched", targets };
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
    this.flights.delete(proxyId);
    for (const [key, tombstone] of this.flightTombstones) {
      if (tombstone.proxyId === proxyId) this.flightTombstones.delete(key);
    }
  }

  private createFlight(proxyId: string, proxyWs: WebSocket, now: number): HistoryFlight {
    return {
      proxyId,
      proxyWs,
      upstreamRequestId: this.upstreamRequestIdFactory(),
      requestIds: new Set<string>(),
      joinUntil: now + this.joinWindowMs,
      expiresAt: now + this.pendingTtlMs,
    };
  }

  private migrateFlight(previous: HistoryFlight, replacement: HistoryFlight, now: number): void {
    if (this.flights.get(previous.proxyId) === previous) this.flights.delete(previous.proxyId);
    this.setFlightTombstone(previous, now);
    for (const externalRequestId of previous.requestIds) {
      const key = routeKey(previous.proxyId, externalRequestId);
      const route = this.routes.get(key);
      if (
        !route ||
        route.state !== "pending" ||
        route.proxyWs !== previous.proxyWs ||
        route.upstreamRequestId !== previous.upstreamRequestId
      ) {
        continue;
      }
      route.upstreamRequestId = replacement.upstreamRequestId;
      replacement.requestIds.add(externalRequestId);
      replacement.expiresAt = Math.max(replacement.expiresAt, route.expiresAt);
    }
  }

  private expireFlight(flight: HistoryFlight, now: number): void {
    if (this.flights.get(flight.proxyId) === flight) this.flights.delete(flight.proxyId);
    this.setFlightTombstone(flight, now);
    for (const externalRequestId of flight.requestIds) {
      const key = routeKey(flight.proxyId, externalRequestId);
      const route = this.routes.get(key);
      if (route?.state === "pending" && route.upstreamRequestId === flight.upstreamRequestId) {
        this.routes.delete(key);
      }
    }
  }

  private setFlightTombstone(flight: HistoryFlight, now: number): void {
    const key = routeKey(flight.proxyId, flight.upstreamRequestId);
    if (!this.flightTombstones.has(key) && this.flightTombstones.size >= this.maxEntries) {
      const oldest = this.flightTombstones.keys().next().value;
      if (oldest !== undefined) this.flightTombstones.delete(oldest);
    }
    this.flightTombstones.set(key, {
      proxyId: flight.proxyId,
      expiresAt: now + this.tombstoneTtlMs,
    });
  }

  private evictOldestRouteTombstone(): boolean {
    let oldestTombstoneKey: string | undefined;
    let oldestTombstoneExpiry = Number.POSITIVE_INFINITY;
    for (const [candidateKey, route] of this.routes) {
      if (route.state === "tombstone" && route.expiresAt < oldestTombstoneExpiry) {
        oldestTombstoneKey = candidateKey;
        oldestTombstoneExpiry = route.expiresAt;
      }
    }
    if (!oldestTombstoneKey) return false;
    this.routes.delete(oldestTombstoneKey);
    return true;
  }

  private pruneExpired(now: number): void {
    for (const flight of this.flights.values()) {
      if (flight.expiresAt <= now) this.expireFlight(flight, now);
    }
    for (const [key, route] of this.routes) {
      if (route.expiresAt <= now) this.routes.delete(key);
    }
    for (const [key, tombstone] of this.flightTombstones) {
      if (tombstone.expiresAt <= now) this.flightTombstones.delete(key);
    }
  }
}
