import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  buildMessage,
  encodeBinaryFrame,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
} from "@dev-anywhere/shared";
import { handleProxyConnection } from "#src/handlers/proxy.js";
import { handleClientConnection } from "#src/handlers/client.js";
import { PtySnapshotRouteRegistry } from "#src/pty-snapshot-route-registry.js";
import { RelayRegistry } from "#src/registry.js";
import { SessionHistoryRouteRegistry } from "#src/session-history-route-registry.js";
import { WebPreviewRouteRegistry } from "#src/web-preview-route-registry.js";
import type { RelayChaos } from "#src/chaos.js";
import { DevicePreviewBridge } from "#src/device-preview-bridge.js";

const logger = createLogger({ name: "proxy-preview-push-routing-test", silent: true });

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  isAlive = true;
  readonly sent: string[] = [];
  readonly terminate = vi.fn();
  readonly close = vi.fn();
  clientId?: string;

  send(data: unknown): void {
    this.sent.push(String(data));
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function receive(socket: FakeSocket, message: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(message)), false);
}

function receiveBinary(socket: FakeSocket, data: Uint8Array): void {
  socket.emit("message", Buffer.from(data), true);
}

function proxyRegistration(proxyId: string): Record<string, unknown> {
  return {
    type: "proxy_register",
    protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
    proxyId,
    proxyVersion: "0.9.0",
  };
}

function previewEvents(): Array<Record<string, unknown>> {
  return [
    {
      type: "preview_state_event",
      epoch: "web-epoch",
      revision: 1,
      preview: {
        previewId: "web-preview",
        name: "Vite",
        source: { kind: "local", url: "http://localhost:5173" },
        state: "ready",
        tunnelProvider: "cloudflare",
        publicUrl: "https://vite-preview.trycloudflare.com",
        createdAt: 1,
        updatedAt: 2,
      },
    },
    {
      type: "preview_removed_event",
      epoch: "web-epoch",
      revision: 2,
      previewId: "web-preview",
    },
    {
      type: "device_preview_state_event",
      epoch: "device-epoch",
      revision: 1,
      preview: {
        previewId: "device-preview",
        name: "iPhone",
        platform: "ios",
        targetId: "simulator-1",
        model: "iPhone 17 Pro",
        osVersion: "26.0",
        state: "ready",
        interactive: true,
        createdAt: 1,
        updatedAt: 2,
      },
    },
    {
      type: "device_preview_removed_event",
      epoch: "device-epoch",
      revision: 2,
      previewId: "device-preview",
    },
  ];
}

function delayedChaos(): { chaos: RelayChaos; flush: () => void } {
  const pending: Array<() => void> = [];
  return {
    chaos: {
      send(ws, data, meta) {
        if (meta.direction === "client_to_proxy") {
          if ((!meta.guard || meta.guard()) && ws.readyState === WebSocket.OPEN) ws.send(data);
          return;
        }
        pending.push(() => {
          if ((!meta.guard || meta.guard()) && ws.readyState === WebSocket.OPEN) ws.send(data);
        });
      },
    },
    flush: () => {
      for (const send of pending.splice(0)) send();
    },
  };
}

function delayedDeviceInputChaos(): { chaos: RelayChaos; flushInputs: () => void } {
  const pendingInputs: Array<() => void> = [];
  return {
    chaos: {
      send(ws, data, meta) {
        const send = () => {
          if ((!meta.guard || meta.guard()) && ws.readyState === WebSocket.OPEN) ws.send(data);
        };
        if (meta.direction === "client_to_proxy" && meta.type === "device_preview_input") {
          pendingInputs.push(send);
          return;
        }
        send();
      },
    },
    flushInputs: () => {
      for (const send of pendingInputs.splice(0)) send();
    },
  };
}

function delayedPreviewManagementRequestChaos(): {
  chaos: RelayChaos;
  flushRequests: () => void;
} {
  const pendingRequests: Array<() => void> = [];
  return {
    chaos: {
      send(ws, data, meta) {
        const send = () => {
          if ((!meta.guard || meta.guard()) && ws.readyState === WebSocket.OPEN) ws.send(data);
        };
        if (
          meta.direction === "client_to_proxy" &&
          (meta.type === "preview_list_request" || meta.type === "device_preview_list_request")
        ) {
          pendingRequests.push(send);
          return;
        }
        send();
      },
    },
    flushRequests: () => {
      for (const send of pendingRequests.splice(0)) send();
    },
  };
}

function queueDelayedPreviewListRequest(kind: "Web" | "Device") {
  const registry = new RelayRegistry();
  const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
  const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
  const webPreviewRoutes = new WebPreviewRouteRegistry();
  const { chaos, flushRequests } = delayedPreviewManagementRequestChaos();
  const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
  const proxyA = new FakeSocket();
  const proxyB = new FakeSocket();
  registry.registerProxy("proxy-a", asWebSocket(proxyA), "0.9.0");
  registry.registerProxy("proxy-b", asWebSocket(proxyB), "0.9.0");

  const client = new FakeSocket();
  client.clientId = "client-1";
  const bindingId = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
  if (!bindingId) throw new Error("missing test binding");
  handleClientConnection(
    asWebSocket(client),
    registry,
    logger,
    ptySnapshotRoutes,
    sessionHistoryRoutes,
    webPreviewRoutes,
    devicePreviewBridge,
    chaos,
  );
  receive(client, {
    type: kind === "Web" ? "preview_list_request" : "device_preview_list_request",
    requestId: "browser-request",
    scope: { proxyId: "proxy-a", bindingId },
  });
  expect(proxyA.sent).toEqual([]);

  return {
    registry,
    webPreviewRoutes,
    devicePreviewBridge,
    proxyA,
    client,
    bindingId,
    flushRequests,
    dispose() {
      devicePreviewBridge.dispose();
      webPreviewRoutes.dispose();
    },
  };
}

interface TestControlLease {
  leaseId: string;
  clientId: string;
  clientWs: WebSocket;
  proxyId: string;
  bindingId: string;
  proxyWs: WebSocket;
  previewId: string;
  streamId?: string;
  controller: boolean;
  lastInputSeq: number;
  rateWindowStartedAt: number;
  inputCount: number;
  outstandingInputSeqs: Set<number>;
}

interface DevicePreviewLeaseInternals {
  leases: Map<string, TestControlLease>;
  streams: Map<string, { lease: TestControlLease }>;
  controllerByPreview: Map<string, string>;
  releaseLease(
    lease: TestControlLease,
    reason: "stream_closed" | "proxy_offline" | "lease_expired",
    notify: boolean,
  ): void;
}

function installTestLease(
  bridge: DevicePreviewBridge,
  registry: RelayRegistry,
  client: FakeSocket,
  proxy: FakeSocket,
  options: {
    clientId: string;
    proxyId: string;
    bindingId: string;
    leaseId: string;
    streamId: string;
    controller: boolean;
  },
): TestControlLease {
  const lease: TestControlLease = {
    leaseId: options.leaseId,
    clientId: options.clientId,
    clientWs: asWebSocket(client),
    proxyId: options.proxyId,
    bindingId: options.bindingId,
    proxyWs: asWebSocket(proxy),
    previewId: "device-preview",
    streamId: options.streamId,
    controller: options.controller,
    lastInputSeq: -1,
    rateWindowStartedAt: 0,
    inputCount: 0,
    outstandingInputSeqs: new Set(),
  };
  const internals = bridge as unknown as DevicePreviewLeaseInternals;
  internals.leases.set(lease.leaseId, lease);
  internals.streams.set(options.streamId, { lease });
  if (lease.controller) {
    internals.controllerByPreview.set(
      JSON.stringify([lease.proxyId, lease.previewId]),
      lease.leaseId,
    );
  }
  expect(
    registry.isCurrentClientBinding(options.clientId, asWebSocket(client), {
      proxyId: options.proxyId,
      bindingId: options.bindingId,
    }),
  ).toBe(true);
  return lease;
}

function clearTestLeases(bridge: DevicePreviewBridge): void {
  const internals = bridge as unknown as DevicePreviewLeaseInternals;
  internals.leases.clear();
  internals.streams.clear();
  internals.controllerByPreview.clear();
}

describe("Proxy preview push routing", () => {
  it("drops every message class from a superseded Proxy socket", () => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger });
    const oldProxy = new FakeSocket();
    const currentProxy = new FakeSocket();
    for (const proxy of [oldProxy, currentProxy]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
      );
    }

    receive(oldProxy, proxyRegistration("proxy-1"));
    receive(currentProxy, proxyRegistration("proxy-1"));
    const client = new FakeSocket();
    registry.bindClientById("client-1", "proxy-1", asWebSocket(client));

    receive(currentProxy, {
      type: "session_sync",
      sessions: [
        {
          id: "current-session",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/current",
          state: "idle",
        },
      ],
    });
    receive(oldProxy, {
      type: "session_sync",
      sessions: [
        {
          id: "stale-session",
          kind: "agent",
          mode: "pty",
          provider: "claude",
          ptyOwner: "proxy-hosted",
          cwd: "/tmp/stale",
          state: "idle",
        },
      ],
    });
    receive(
      oldProxy,
      buildMessage(
        "assistant_message",
        "stale-session",
        1,
        { turnId: "stale-turn", revision: 1, text: "stale", status: "completed" },
        "proxy",
      ),
    );
    receiveBinary(oldProxy, encodeBinaryFrame("stale-session", 1, new TextEncoder().encode("x")));

    expect(registry.getSessionsForProxy("proxy-1")).toEqual(["current-session"]);
    expect(client.sent).toEqual([]);

    receive(
      currentProxy,
      buildMessage(
        "assistant_message",
        "current-session",
        1,
        { turnId: "current-turn", revision: 1, text: "current", status: "completed" },
        "proxy",
      ),
    );
    expect(client.sent).toHaveLength(1);

    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it("rejects a second Proxy registration on the same socket without creating a ghost identity", () => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger });
    const proxy = new FakeSocket();
    handleProxyConnection(
      asWebSocket(proxy),
      registry,
      logger,
      ptySnapshotRoutes,
      sessionHistoryRoutes,
      webPreviewRoutes,
      devicePreviewBridge,
    );

    receive(proxy, proxyRegistration("proxy-a"));
    receive(proxy, proxyRegistration("proxy-b"));

    expect(proxy.close).toHaveBeenCalledWith(
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      "protocol_mismatch",
    );
    expect(registry.getProxy("proxy-a")).toBe(asWebSocket(proxy));
    expect(registry.hasProxy("proxy-b")).toBe(false);

    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it("drops Web and Device Preview pushes from a superseded Proxy socket", () => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger });
    const oldProxy = new FakeSocket();
    const currentProxy = new FakeSocket();

    handleProxyConnection(
      asWebSocket(oldProxy),
      registry,
      logger,
      ptySnapshotRoutes,
      sessionHistoryRoutes,
      webPreviewRoutes,
      devicePreviewBridge,
    );
    handleProxyConnection(
      asWebSocket(currentProxy),
      registry,
      logger,
      ptySnapshotRoutes,
      sessionHistoryRoutes,
      webPreviewRoutes,
      devicePreviewBridge,
    );

    receive(oldProxy, proxyRegistration("proxy-1"));
    receive(currentProxy, proxyRegistration("proxy-1"));
    expect(oldProxy.terminate).toHaveBeenCalledOnce();

    const client = new FakeSocket();
    client.clientId = "client-1";
    registry.bindClientById("client-1", "proxy-1", asWebSocket(client));

    for (const event of previewEvents()) receive(oldProxy, event);
    expect(client.sent).toEqual([]);

    for (const event of previewEvents()) receive(currentProxy, event);
    expect(client.sent.map((raw) => JSON.parse(raw).type)).toEqual([
      "preview_state_push",
      "preview_removed_push",
      "device_preview_state_push",
      "device_preview_removed_push",
    ]);
    expect(client.sent.map((raw) => JSON.parse(raw).scope)).toEqual(
      Array.from({ length: 4 }, () => ({
        proxyId: "proxy-1",
        bindingId: expect.any(String),
      })),
    );

    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["Web", previewEvents()[0]!],
    ["Device", previewEvents()[2]!],
  ])("drops a delayed %s push after the client switches A to B", (_kind, event) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    for (const proxy of [proxyA, proxyB]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(proxyA, proxyRegistration("proxy-a"));
    receive(proxyB, proxyRegistration("proxy-b"));

    const client = new FakeSocket();
    client.clientId = "client-1";
    registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    receive(proxyA, event);
    registry.bindClientById("client-1", "proxy-b", asWebSocket(client));

    flush();
    expect(client.sent).toEqual([]);
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["Web", previewEvents()[0]!],
    ["Device", previewEvents()[2]!],
  ])("drops a delayed %s push after its Proxy socket is replaced", (_kind, event) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const oldProxy = new FakeSocket();
    const replacementProxy = new FakeSocket();
    for (const proxy of [oldProxy, replacementProxy]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(oldProxy, proxyRegistration("proxy-a"));
    const client = new FakeSocket();
    client.clientId = "client-1";
    registry.bindClientById("client-1", "proxy-a", asWebSocket(client));

    receive(oldProxy, event);
    receive(replacementProxy, proxyRegistration("proxy-a"));
    client.sent.length = 0;
    flush();

    expect(client.sent.map((raw) => JSON.parse(raw).type)).toEqual(["proxy_online"]);
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["Web", previewEvents()[0]!],
    ["Device", previewEvents()[2]!],
  ])("drops a delayed %s push across the A1 to B to A2 ABA cycle", (_kind, event) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    for (const proxy of [proxyA, proxyB]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(proxyA, proxyRegistration("proxy-a"));
    receive(proxyB, proxyRegistration("proxy-b"));

    const client = new FakeSocket();
    client.clientId = "client-1";
    const bindingA1 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    receive(proxyA, event);
    registry.bindClientById("client-1", "proxy-b", asWebSocket(client));
    const bindingA2 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    expect(bindingA2).not.toBe(bindingA1);

    flush();
    expect(client.sent).toEqual([]);
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["A to B rebinding", false, false],
    ["A1 to B to A2 rebinding", true, false],
    ["Proxy socket replacement", false, true],
  ])("drops a delayed Web management response after %s", (_label, aba, replaceProxy) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry({
      upstreamRequestIdFactory: () => "web-upstream",
    });
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    for (const proxy of [proxyA, proxyB]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(proxyA, proxyRegistration("proxy-a"));
    receive(proxyB, proxyRegistration("proxy-b"));

    const client = new FakeSocket();
    client.clientId = "client-1";
    registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    webPreviewRoutes.register(
      "proxy-a",
      "browser-request",
      "preview_list_response",
      asWebSocket(client),
      asWebSocket(proxyA),
    );
    receive(proxyA, {
      type: "preview_list_response",
      requestId: "web-upstream",
      scope: { proxyId: "forged-proxy", bindingId: "forged-binding" },
      epoch: "epoch-a",
      revision: 1,
      previews: [],
    });
    if (replaceProxy) {
      const replacementProxy = new FakeSocket();
      handleProxyConnection(
        asWebSocket(replacementProxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
      receive(replacementProxy, proxyRegistration("proxy-a"));
      client.sent.length = 0;
    } else {
      registry.bindClientById("client-1", "proxy-b", asWebSocket(client));
      if (aba) registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    }

    flush();
    expect(client.sent.map((raw) => JSON.parse(raw).type)).toEqual(
      replaceProxy ? ["proxy_online"] : [],
    );
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each(["Web", "Device"] as const)(
    "forwards a delayed current %s management request",
    (kind) => {
      const setup = queueDelayedPreviewListRequest(kind);

      setup.flushRequests();

      expect(setup.proxyA.sent.map((raw) => JSON.parse(raw))).toEqual([
        expect.objectContaining({
          type: kind === "Web" ? "preview_list_request" : "device_preview_list_request",
          scope: { proxyId: "proxy-a", bindingId: setup.bindingId },
        }),
      ]);
      setup.dispose();
    },
  );

  it.each(["Web", "Device"] as const)(
    "drops a delayed %s management request after switching to another Proxy",
    (kind) => {
      const setup = queueDelayedPreviewListRequest(kind);

      setup.registry.bindClientById("client-1", "proxy-b", asWebSocket(setup.client));
      setup.flushRequests();

      expect(setup.proxyA.sent).toEqual([]);
      setup.dispose();
    },
  );

  it.each(["Web", "Device"] as const)(
    "drops a delayed %s management request after rebinding to the same Proxy",
    (kind) => {
      const setup = queueDelayedPreviewListRequest(kind);

      setup.registry.bindClientById("client-1", "proxy-a", asWebSocket(setup.client));
      setup.flushRequests();

      expect(setup.proxyA.sent).toEqual([]);
      setup.dispose();
    },
  );

  it.each(["Web", "Device"] as const)(
    "drops a delayed %s management request after the client socket is replaced",
    (kind) => {
      const setup = queueDelayedPreviewListRequest(kind);
      const replacementClient = new FakeSocket();
      replacementClient.clientId = "client-1";

      setup.registry.bindClientById("client-1", "proxy-a", asWebSocket(replacementClient));
      setup.flushRequests();

      expect(setup.proxyA.sent).toEqual([]);
      setup.dispose();
    },
  );

  it.each(["Web", "Device"] as const)(
    "drops a delayed %s management request after the Proxy socket is replaced",
    (kind) => {
      const setup = queueDelayedPreviewListRequest(kind);

      setup.registry.registerProxy("proxy-a", asWebSocket(new FakeSocket()), "0.9.0");
      setup.flushRequests();

      expect(setup.proxyA.sent).toEqual([]);
      setup.dispose();
    },
  );

  it.each([
    ["A to B rebinding", false, false],
    ["A1 to B to A2 rebinding", true, false],
    ["Proxy socket replacement", false, true],
  ])("drops a delayed Device management response after %s", (_label, aba, replaceProxy) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    for (const proxy of [proxyA, proxyB]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(proxyA, proxyRegistration("proxy-a"));
    receive(proxyB, proxyRegistration("proxy-b"));

    const client = new FakeSocket();
    client.clientId = "client-1";
    const bindingA1 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    if (!bindingA1) throw new Error("missing test binding");
    devicePreviewBridge.handleClientControl(asWebSocket(client), {
      type: "device_preview_list_request",
      requestId: "browser-request",
      scope: { proxyId: "proxy-a", bindingId: bindingA1 },
    });
    const forwarded = proxyA.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.type === "device_preview_list_request");
    expect(forwarded?.requestId).toEqual(expect.any(String));
    receive(proxyA, {
      type: "device_preview_list_response",
      requestId: forwarded?.requestId,
      scope: { proxyId: "forged-proxy", bindingId: "forged-binding" },
      epoch: "epoch-a",
      revision: 1,
      previews: [],
    });
    if (replaceProxy) {
      const replacementProxy = new FakeSocket();
      handleProxyConnection(
        asWebSocket(replacementProxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
      receive(replacementProxy, proxyRegistration("proxy-a"));
      client.sent.length = 0;
    } else {
      registry.bindClientById("client-1", "proxy-b", asWebSocket(client));
      if (aba) registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    }

    flush();
    expect(client.sent.map((raw) => JSON.parse(raw).type)).toEqual(
      replaceProxy ? ["proxy_online"] : [],
    );
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["A to B", false],
    ["A1 to B to A2", true],
  ])("drops a delayed control-revoked push after %s rebinding", (_label, aba) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const devicePreviewBridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    for (const proxy of [proxyA, proxyB]) {
      handleProxyConnection(
        asWebSocket(proxy),
        registry,
        logger,
        ptySnapshotRoutes,
        sessionHistoryRoutes,
        webPreviewRoutes,
        devicePreviewBridge,
        chaos,
      );
    }
    receive(proxyA, proxyRegistration("proxy-a"));
    receive(proxyB, proxyRegistration("proxy-b"));

    const client = new FakeSocket();
    client.clientId = "client-1";
    const bindingA1 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    if (!bindingA1) throw new Error("missing test binding");
    const lease: TestControlLease = {
      leaseId: "lease-a1",
      clientId: "client-1",
      clientWs: asWebSocket(client),
      proxyId: "proxy-a",
      bindingId: bindingA1,
      proxyWs: asWebSocket(proxyA),
      previewId: "device-preview",
      controller: true,
      lastInputSeq: -1,
      rateWindowStartedAt: 0,
      inputCount: 0,
      outstandingInputSeqs: new Set(),
    };
    const internals = devicePreviewBridge as unknown as DevicePreviewLeaseInternals;
    internals.leases.set(lease.leaseId, lease);
    internals.controllerByPreview.set(
      JSON.stringify([lease.proxyId, lease.previewId]),
      lease.leaseId,
    );
    internals.releaseLease(lease, "stream_closed", true);

    registry.bindClientById("client-1", "proxy-b", asWebSocket(client));
    if (aba) registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    flush();

    expect(client.sent).toEqual([]);
    devicePreviewBridge.dispose();
    webPreviewRoutes.dispose();
  });

  it.each([
    ["A to B", false],
    ["A1 to B to A2", true],
  ])("drops a delayed Device input after %s rebinding", (_label, aba) => {
    const registry = new RelayRegistry();
    const { chaos, flushInputs } = delayedDeviceInputChaos();
    const bridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    registry.registerProxy("proxy-a", asWebSocket(proxyA), "0.9.0");
    registry.registerProxy("proxy-b", asWebSocket(proxyB), "0.9.0");
    bridge.registerProxyConnection("proxy-a", asWebSocket(proxyA));

    const client = new FakeSocket();
    client.clientId = "client-1";
    const bindingA1 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
    if (!bindingA1) throw new Error("missing test binding");
    const lease = installTestLease(bridge, registry, client, proxyA, {
      clientId: "client-1",
      proxyId: "proxy-a",
      bindingId: bindingA1,
      leaseId: "lease-a1",
      streamId: "stream-a1",
      controller: true,
    });

    expect(
      bridge.handleClientControl(asWebSocket(client), {
        type: "device_preview_input",
        scope: { proxyId: "proxy-a", bindingId: bindingA1 },
        leaseId: lease.leaseId,
        inputSeq: 1,
        input: { kind: "button", button: "home" },
      }),
    ).toBe(true);
    expect(proxyA.sent).toEqual([]);

    registry.bindClientById("client-1", "proxy-b", asWebSocket(client));
    if (aba) {
      const bindingA2 = registry.bindClientById("client-1", "proxy-a", asWebSocket(client));
      expect(bindingA2).not.toBe(bindingA1);
    }
    flushInputs();

    expect(proxyA.sent).toEqual([]);
    clearTestLeases(bridge);
    bridge.dispose();
  });

  it("drops a delayed Device input after another lease takes control", () => {
    const registry = new RelayRegistry();
    const { chaos, flushInputs } = delayedDeviceInputChaos();
    const bridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxy = new FakeSocket();
    registry.registerProxy("proxy-a", asWebSocket(proxy), "0.9.0");
    bridge.registerProxyConnection("proxy-a", asWebSocket(proxy));

    const clientA = new FakeSocket();
    clientA.clientId = "client-a";
    const bindingA = registry.bindClientById("client-a", "proxy-a", asWebSocket(clientA));
    if (!bindingA) throw new Error("missing controller binding");
    const leaseA = installTestLease(bridge, registry, clientA, proxy, {
      clientId: "client-a",
      proxyId: "proxy-a",
      bindingId: bindingA,
      leaseId: "lease-a",
      streamId: "stream-a",
      controller: true,
    });

    const clientB = new FakeSocket();
    clientB.clientId = "client-b";
    const bindingB = registry.bindClientById("client-b", "proxy-a", asWebSocket(clientB));
    if (!bindingB) throw new Error("missing viewer binding");
    const leaseB = installTestLease(bridge, registry, clientB, proxy, {
      clientId: "client-b",
      proxyId: "proxy-a",
      bindingId: bindingB,
      leaseId: "lease-b",
      streamId: "stream-b",
      controller: false,
    });

    bridge.handleClientControl(asWebSocket(clientA), {
      type: "device_preview_input",
      scope: { proxyId: "proxy-a", bindingId: bindingA },
      leaseId: leaseA.leaseId,
      inputSeq: 1,
      input: { kind: "button", button: "home" },
    });
    expect(proxy.sent).toEqual([]);

    bridge.handleClientControl(asWebSocket(clientB), {
      type: "device_preview_control_claim_request",
      requestId: "claim-b",
      scope: { proxyId: "proxy-a", bindingId: bindingB },
      leaseId: leaseB.leaseId,
    });
    expect(proxy.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "device_preview_input_revoke",
        leaseId: leaseA.leaseId,
        reason: "control_taken_over",
      },
    ]);

    flushInputs();
    expect(proxy.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "device_preview_input_revoke",
        leaseId: leaseA.leaseId,
        reason: "control_taken_over",
      },
    ]);
    clearTestLeases(bridge);
    bridge.dispose();
  });

  it.each([
    ["different Proxy", "proxy-b"],
    ["same Proxy", "proxy-a"],
  ])("delivers only the newest delayed proxy_select ACK for the %s case", (_label, nextProxyId) => {
    const registry = new RelayRegistry();
    const ptySnapshotRoutes = new PtySnapshotRouteRegistry();
    const sessionHistoryRoutes = new SessionHistoryRouteRegistry();
    const webPreviewRoutes = new WebPreviewRouteRegistry();
    const { chaos, flush } = delayedChaos();
    const bridge = new DevicePreviewBridge({ registry, logger, chaos });
    const proxyA = new FakeSocket();
    const proxyB = new FakeSocket();
    registry.registerProxy("proxy-a", asWebSocket(proxyA), "0.9.0");
    registry.registerProxy("proxy-b", asWebSocket(proxyB), "0.9.0");

    const client = new FakeSocket();
    handleClientConnection(
      asWebSocket(client),
      registry,
      logger,
      ptySnapshotRoutes,
      sessionHistoryRoutes,
      webPreviewRoutes,
      bridge,
      chaos,
    );
    receive(client, {
      type: "client_register",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      clientId: "client-select",
      browserName: "Chrome",
      osName: "macOS",
      deviceKind: "desktop",
    });
    expect(client.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
      },
    ]);
    client.sent.length = 0;

    receive(client, {
      type: "proxy_select",
      requestId: "select-old",
      proxyId: "proxy-a",
    });
    receive(client, {
      type: "proxy_select",
      requestId: "select-current",
      proxyId: nextProxyId,
    });
    expect(client.sent).toEqual([]);

    flush();
    const responses = client.sent.map((raw) => JSON.parse(raw));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: "proxy_select_response",
      requestId: "select-current",
      success: true,
      proxyId: nextProxyId,
      bindingId: expect.any(String),
    });

    bridge.dispose();
    webPreviewRoutes.dispose();
  });
});
