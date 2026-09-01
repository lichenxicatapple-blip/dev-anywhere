import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import type { RelayControlMessage } from "@dev-anywhere/shared";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_PER_CLIENT = 64;
const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;

export const webPreviewResponseByRequest = {
  preview_static_inspect_request: "preview_static_inspect_response",
  preview_create_request: "preview_create_response",
  preview_list_request: "preview_list_response",
  preview_reconnect_request: "preview_reconnect_response",
  preview_close_request: "preview_close_response",
} as const;

export type WebPreviewRequestType = keyof typeof webPreviewResponseByRequest;
export type WebPreviewResponseType = (typeof webPreviewResponseByRequest)[WebPreviewRequestType];
export type WebPreviewRequestMessage = Extract<
  RelayControlMessage,
  { type: WebPreviewRequestType }
>;
export type WebPreviewResponseMessage = Extract<
  RelayControlMessage,
  { type: WebPreviewResponseType }
>;

const webPreviewRequestTypes = new Set<string>(Object.keys(webPreviewResponseByRequest));
const webPreviewResponseTypes = new Set<string>(Object.values(webPreviewResponseByRequest));

function isWebPreviewRequestType(type: string): type is WebPreviewRequestType {
  return webPreviewRequestTypes.has(type);
}

function isWebPreviewResponseType(type: string): type is WebPreviewResponseType {
  return webPreviewResponseTypes.has(type);
}

export function isWebPreviewRequestMessage(
  message: RelayControlMessage,
): message is WebPreviewRequestMessage {
  return isWebPreviewRequestType(message.type);
}

export function isWebPreviewResponseMessage(
  message: RelayControlMessage,
): message is WebPreviewResponseMessage {
  return isWebPreviewResponseType(message.type);
}

type PendingRoute = {
  state: "pending";
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  clientRequestId: string;
  expectedResponseType: WebPreviewResponseType;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type TombstoneRoute = {
  state: "tombstone";
  proxyId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type WebPreviewRoute = PendingRoute | TombstoneRoute;

type WebPreviewRouteRegistration =
  | { kind: "registered"; upstreamRequestId: string }
  | { kind: "client_capacity_exceeded" }
  | { kind: "capacity_exceeded" };

type WebPreviewRouteResolution =
  | { kind: "matched"; clientWs: WebSocket; clientRequestId: string }
  | { kind: "response_type_mismatch"; expectedResponseType: WebPreviewResponseType }
  | { kind: "stale_proxy" }
  | { kind: "tombstone" }
  | { kind: "unmatched" };

interface WebPreviewRouteRegistryOptions {
  maxEntries?: number;
  maxPendingPerClient?: number;
  pendingTtlMs?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
  upstreamRequestIdFactory?: () => string;
}

function routeKey(proxyId: string, upstreamRequestId: string): string {
  return JSON.stringify([proxyId, upstreamRequestId]);
}

/**
 * Correlates every Web Preview request with the exact browser socket that initiated it. Client
 * request IDs never cross the Proxy wire, so equal IDs from different tabs cannot collide. A
 * request records its expected response type as well as its Proxy socket; malformed or stale
 * responses are dropped rather than falling through to the generic Proxy broadcast path.
 */
export class WebPreviewRouteRegistry {
  private readonly routes = new Map<string, WebPreviewRoute>();
  private readonly maxEntries: number;
  private readonly maxPendingPerClient: number;
  private readonly pendingTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;
  private readonly upstreamRequestIdFactory: () => string;
  private upstreamRequestSequence = 0;

  constructor(options: WebPreviewRouteRegistryOptions = {}) {
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
        return `relay-preview-${this.upstreamRequestSequence.toString(36)}-${nanoid(12)}`;
      });
  }

  register(
    proxyId: string,
    clientRequestId: string,
    expectedResponseType: WebPreviewResponseType,
    clientWs: WebSocket,
    proxyWs: WebSocket,
  ): WebPreviewRouteRegistration {
    const now = this.now();
    this.pruneExpired(now);

    let clientPendingCount = 0;
    for (const route of this.routes.values()) {
      if (route.state === "pending" && route.clientWs === clientWs) {
        clientPendingCount += 1;
        if (clientPendingCount >= this.maxPendingPerClient) {
          return { kind: "client_capacity_exceeded" };
        }
      }
    }

    if (this.routes.size >= this.maxEntries && !this.evictOldestTombstone()) {
      return { kind: "capacity_exceeded" };
    }

    const upstreamRequestId = this.createUniqueUpstreamRequestId(proxyId);
    const key = routeKey(proxyId, upstreamRequestId);
    const expiresAt = now + this.pendingTtlMs;
    const timer = setTimeout(() => {
      if (this.routes.get(key) !== route) return;
      this.setTombstone(key, proxyId, this.now());
    }, this.pendingTtlMs);
    timer.unref?.();
    const route: PendingRoute = {
      state: "pending",
      proxyId,
      proxyWs,
      clientWs,
      clientRequestId,
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
    responseType: WebPreviewResponseType,
    proxyWs: WebSocket,
  ): WebPreviewRouteResolution {
    const now = this.now();
    this.pruneExpired(now);
    const key = routeKey(proxyId, upstreamRequestId);
    const route = this.routes.get(key);
    if (!route) return { kind: "unmatched" };
    if (route.state === "tombstone") return { kind: "tombstone" };
    if (route.proxyWs !== proxyWs) return { kind: "stale_proxy" };
    if (route.expectedResponseType !== responseType) {
      return {
        kind: "response_type_mismatch",
        expectedResponseType: route.expectedResponseType,
      };
    }

    const { clientWs, clientRequestId } = route;
    this.setTombstone(key, proxyId, now);
    return { kind: "matched", clientWs, clientRequestId };
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
    throw new Error("Unable to allocate a unique Web Preview upstream requestId");
  }

  private setTombstone(key: string, proxyId: string, now: number): void {
    const current = this.routes.get(key);
    if (current) clearTimeout(current.timer);
    const expiresAt = now + this.tombstoneTtlMs;
    const timer = setTimeout(() => {
      if (this.routes.get(key) === route) this.routes.delete(key);
    }, this.tombstoneTtlMs);
    timer.unref?.();
    const route: TombstoneRoute = {
      state: "tombstone",
      proxyId,
      expiresAt,
      timer,
    };
    this.routes.set(key, route);
  }

  private deleteRoute(key: string, route: WebPreviewRoute): void {
    clearTimeout(route.timer);
    this.routes.delete(key);
  }

  private evictOldestTombstone(): boolean {
    let oldestKey: string | undefined;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, route] of this.routes) {
      if (route.state === "tombstone" && route.expiresAt < oldestExpiry) {
        oldestKey = key;
        oldestExpiry = route.expiresAt;
      }
    }
    if (!oldestKey) return false;
    const route = this.routes.get(oldestKey);
    if (route) this.deleteRoute(oldestKey, route);
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, route] of this.routes) {
      if (route.expiresAt <= now) this.deleteRoute(key, route);
    }
  }
}
