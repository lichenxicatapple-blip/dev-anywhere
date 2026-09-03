import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import type { PreviewScope } from "@dev-anywhere/shared";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_PER_CLIENT = 64;
const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;

type PendingRoute<ResponseType extends string> = {
  state: "pending";
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  clientId: string;
  scope: PreviewScope;
  clientRequestId: string;
  expectedResponseType: ResponseType;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type TombstoneRoute = {
  state: "tombstone";
  proxyId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type Route<ResponseType extends string> = PendingRoute<ResponseType> | TombstoneRoute;

type PreviewRouteRegistration =
  | { kind: "registered"; upstreamRequestId: string }
  | { kind: "client_capacity_exceeded" }
  | { kind: "capacity_exceeded" };

type PreviewRouteResolution<ResponseType extends string> =
  | {
      kind: "matched";
      clientWs: WebSocket;
      clientId: string;
      clientRequestId: string;
      scope: PreviewScope;
    }
  | { kind: "response_type_mismatch"; expectedResponseType: ResponseType }
  | { kind: "stale_proxy" }
  | { kind: "tombstone" }
  | { kind: "unmatched" };

export interface PreviewRouteRegistryOptions {
  maxEntries?: number;
  maxPendingPerClient?: number;
  pendingTtlMs?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
  upstreamRequestIdFactory?: () => string;
}

interface PreviewRouteRegistryConfig {
  label: string;
  requestIdPrefix: string;
}

function routeKey(proxyId: string, upstreamRequestId: string): string {
  return JSON.stringify([proxyId, upstreamRequestId]);
}

type BoundClientSocket = WebSocket & {
  clientId?: string;
  boundProxyId?: string;
  bindingId?: string;
};

/**
 * Correlates a request with the exact browser and Proxy sockets that carried it. Request IDs are
 * rewritten before crossing the Relay so equal IDs from different browsers cannot collide.
 * Completed, abandoned, and expired routes become short-lived tombstones so late responses cannot
 * fall through to a broadcast path.
 */
export class PreviewRouteRegistry<ResponseType extends string> {
  private readonly routes = new Map<string, Route<ResponseType>>();
  private readonly maxEntries: number;
  private readonly maxPendingPerClient: number;
  private readonly pendingTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;
  private readonly upstreamRequestIdFactory: () => string;
  private upstreamRequestSequence = 0;

  constructor(
    private readonly config: PreviewRouteRegistryConfig,
    options: PreviewRouteRegistryOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxPendingPerClient = Math.max(
      1,
      options.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT,
    );
    this.pendingTtlMs = Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
    this.tombstoneTtlMs = Math.max(1, options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.upstreamRequestIdFactory =
      options.upstreamRequestIdFactory ??
      (() => {
        this.upstreamRequestSequence += 1;
        return `${config.requestIdPrefix}-${this.upstreamRequestSequence.toString(36)}-${nanoid(12)}`;
      });
  }

  register(
    proxyId: string,
    clientRequestId: string,
    expectedResponseType: ResponseType,
    clientWs: WebSocket,
    proxyWs: WebSocket,
  ): PreviewRouteRegistration {
    const now = this.now();
    this.pruneExpired(now);
    const boundClient = clientWs as BoundClientSocket;
    if (!boundClient.clientId || boundClient.boundProxyId !== proxyId || !boundClient.bindingId) {
      throw new Error(`${this.config.label} route requires an exact client binding`);
    }

    let pendingForClient = 0;
    for (const route of this.routes.values()) {
      if (route.state !== "pending" || route.clientWs !== clientWs) continue;
      pendingForClient += 1;
      if (pendingForClient >= this.maxPendingPerClient) {
        return { kind: "client_capacity_exceeded" };
      }
    }

    if (this.routes.size >= this.maxEntries && !this.evictOldestTombstone()) {
      return { kind: "capacity_exceeded" };
    }

    const upstreamRequestId = this.createUniqueUpstreamRequestId(proxyId);
    const key = routeKey(proxyId, upstreamRequestId);
    const expiresAt = now + this.pendingTtlMs;
    const timer = setTimeout(() => {
      if (this.routes.get(key) === route) this.setTombstone(key, proxyId, this.now());
    }, this.pendingTtlMs);
    timer.unref?.();
    const route: PendingRoute<ResponseType> = {
      state: "pending",
      proxyId,
      proxyWs,
      clientWs,
      clientId: boundClient.clientId,
      clientRequestId,
      scope: { proxyId, bindingId: boundClient.bindingId },
      expectedResponseType,
      expiresAt,
      timer,
    };
    this.routes.set(key, route);
    return { kind: "registered", upstreamRequestId };
  }

  resolve(
    proxyId: string,
    upstreamRequestId: string,
    responseType: ResponseType,
    proxyWs: WebSocket,
  ): PreviewRouteResolution<ResponseType> {
    const now = this.now();
    this.pruneExpired(now);
    const key = routeKey(proxyId, upstreamRequestId);
    const route = this.routes.get(key);
    if (!route) return { kind: "unmatched" };
    if (route.state === "tombstone") return { kind: "tombstone" };
    if (route.proxyWs !== proxyWs) return { kind: "stale_proxy" };
    if (route.expectedResponseType !== responseType) {
      return { kind: "response_type_mismatch", expectedResponseType: route.expectedResponseType };
    }

    const result = {
      clientWs: route.clientWs,
      clientId: route.clientId,
      clientRequestId: route.clientRequestId,
      scope: route.scope,
    };
    this.setTombstone(key, proxyId, now);
    return { kind: "matched", ...result };
  }

  abandonSocket(clientWs: WebSocket): void {
    const now = this.now();
    this.pruneExpired(now);
    for (const [key, route] of this.routes) {
      if (route.state === "pending" && route.clientWs === clientWs) {
        this.setTombstone(key, route.proxyId, now);
      }
    }
  }

  clearProxy(proxyId: string): void {
    for (const [key, route] of this.routes) {
      if (route.proxyId === proxyId) this.deleteRoute(key, route);
    }
  }

  dispose(): void {
    for (const [key, route] of this.routes) this.deleteRoute(key, route);
  }

  private createUniqueUpstreamRequestId(proxyId: string): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.upstreamRequestIdFactory();
      if (!this.routes.has(routeKey(proxyId, candidate))) return candidate;
    }
    throw new Error(`Unable to allocate a unique ${this.config.label} requestId`);
  }

  private setTombstone(key: string, proxyId: string, now: number): void {
    const current = this.routes.get(key);
    if (current) clearTimeout(current.timer);
    const expiresAt = now + this.tombstoneTtlMs;
    const timer = setTimeout(() => {
      if (this.routes.get(key) === route) this.routes.delete(key);
    }, this.tombstoneTtlMs);
    timer.unref?.();
    const route: TombstoneRoute = { state: "tombstone", proxyId, expiresAt, timer };
    this.routes.set(key, route);
  }

  private deleteRoute(key: string, route: Route<ResponseType>): void {
    clearTimeout(route.timer);
    this.routes.delete(key);
  }

  private evictOldestTombstone(): boolean {
    let candidate: [string, TombstoneRoute] | undefined;
    for (const [key, route] of this.routes) {
      if (route.state !== "tombstone") continue;
      if (!candidate || route.expiresAt < candidate[1].expiresAt) candidate = [key, route];
    }
    if (!candidate) return false;
    this.deleteRoute(candidate[0], candidate[1]);
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, route] of this.routes) {
      if (route.expiresAt <= now) this.deleteRoute(key, route);
    }
  }
}
