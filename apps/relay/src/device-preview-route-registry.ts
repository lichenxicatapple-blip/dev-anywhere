import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import type { RelayControlMessage } from "@dev-anywhere/shared";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_PER_CLIENT = 64;
const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;

export const devicePreviewResponseByRequest = {
  device_preview_capability_request: "device_preview_capability_response",
  device_preview_targets_request: "device_preview_targets_response",
  device_preview_create_request: "device_preview_create_response",
  device_preview_list_request: "device_preview_list_response",
  device_preview_reconnect_request: "device_preview_reconnect_response",
  device_preview_close_request: "device_preview_close_response",
} as const;

export type DevicePreviewRequestType = keyof typeof devicePreviewResponseByRequest;
export type DevicePreviewResponseType =
  (typeof devicePreviewResponseByRequest)[DevicePreviewRequestType];
export type DevicePreviewRequestMessage = Extract<
  RelayControlMessage,
  { type: DevicePreviewRequestType }
>;
export type DevicePreviewResponseMessage = Extract<
  RelayControlMessage,
  { type: DevicePreviewResponseType }
>;

const requestTypes = new Set<string>(Object.keys(devicePreviewResponseByRequest));
const responseTypes = new Set<string>(Object.values(devicePreviewResponseByRequest));

export function isDevicePreviewRequestMessage(
  message: RelayControlMessage,
): message is DevicePreviewRequestMessage {
  return requestTypes.has(message.type);
}

export function isDevicePreviewResponseMessage(
  message: RelayControlMessage,
): message is DevicePreviewResponseMessage {
  return responseTypes.has(message.type);
}

type PendingRoute = {
  state: "pending";
  proxyId: string;
  proxyWs: WebSocket;
  clientWs: WebSocket;
  clientRequestId: string;
  expectedResponseType: DevicePreviewResponseType;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type TombstoneRoute = {
  state: "tombstone";
  proxyId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type Route = PendingRoute | TombstoneRoute;

export type DevicePreviewRouteRegistration =
  | { kind: "registered"; upstreamRequestId: string }
  | { kind: "client_capacity_exceeded" }
  | { kind: "capacity_exceeded" };

export type DevicePreviewRouteResolution =
  | { kind: "matched"; clientWs: WebSocket; clientRequestId: string }
  | { kind: "response_type_mismatch"; expectedResponseType: DevicePreviewResponseType }
  | { kind: "stale_proxy" }
  | { kind: "tombstone" }
  | { kind: "unmatched" };

interface DevicePreviewRouteRegistryOptions {
  maxEntries?: number;
  maxPendingPerClient?: number;
  pendingTtlMs?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
  upstreamRequestIdFactory?: () => string;
}

function routeKey(proxyId: string, requestId: string): string {
  return JSON.stringify([proxyId, requestId]);
}

/** Keeps request/response management traffic scoped to the exact initiating browser socket. */
export class DevicePreviewRouteRegistry {
  private readonly routes = new Map<string, Route>();
  private readonly maxEntries: number;
  private readonly maxPendingPerClient: number;
  private readonly pendingTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;
  private readonly upstreamRequestIdFactory: () => string;
  private sequence = 0;

  constructor(options: DevicePreviewRouteRegistryOptions = {}) {
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
        this.sequence += 1;
        return `relay-device-preview-${this.sequence.toString(36)}-${nanoid(12)}`;
      });
  }

  register(
    proxyId: string,
    clientRequestId: string,
    expectedResponseType: DevicePreviewResponseType,
    clientWs: WebSocket,
    proxyWs: WebSocket,
  ): DevicePreviewRouteRegistration {
    const now = this.now();
    this.pruneExpired(now);

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

    const upstreamRequestId = this.createUniqueRequestId(proxyId);
    const key = routeKey(proxyId, upstreamRequestId);
    const expiresAt = now + this.pendingTtlMs;
    const timer = setTimeout(() => {
      if (this.routes.get(key) === route) this.setTombstone(key, proxyId, this.now());
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
    responseType: DevicePreviewResponseType,
    proxyWs: WebSocket,
  ): DevicePreviewRouteResolution {
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
    const result = { clientWs: route.clientWs, clientRequestId: route.clientRequestId };
    this.setTombstone(key, proxyId, now);
    return { kind: "matched", ...result };
  }

  abandonSocket(clientWs: WebSocket): void {
    const now = this.now();
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

  private createUniqueRequestId(proxyId: string): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.upstreamRequestIdFactory();
      if (!this.routes.has(routeKey(proxyId, candidate))) return candidate;
    }
    throw new Error("Unable to allocate a unique Device Preview requestId");
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

  private deleteRoute(key: string, route: Route): void {
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
