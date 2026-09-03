import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import type { PreviewScope } from "@dev-anywhere/shared";
import { createRelayServer, type RelayServer } from "#src/server.js";
import {
  collectMessages,
  getPort,
  settle,
  waitForMessage,
  waitForMessageType,
  waitForOpen,
} from "../helpers.js";

const logger = createLogger({ name: "web-preview-routing-test", silent: true });
const untrustedProxyScope = { proxyId: "forged-proxy", bindingId: "forged-binding" } as const;

describe("Web Preview routing integration", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  beforeEach(async () => {
    relay = createRelayServer({ port: 0, heartbeatInterval: 60_000, logger });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, resolve));
    port = getPort(relay);
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    connections.length = 0;
    await relay.close();
  });

  function connect(path: "/proxy" | "/client"): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    connections.push(ws);
    return ws;
  }

  async function registerClient(client: WebSocket, clientId: string): Promise<void> {
    client.send(
      JSON.stringify({
        type: "client_register",
        clientId,
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    await waitForMessage(client);
  }

  async function setup(): Promise<{
    proxy: WebSocket;
    clientA: WebSocket;
    clientB: WebSocket;
    scopeA: PreviewScope;
    scopeB: PreviewScope;
  }> {
    const proxy = connect("/proxy");
    await waitForOpen(proxy);
    const registered = waitForMessage(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "preview-proxy" }));
    await registered;

    const clientA = connect("/client");
    await waitForOpen(clientA);
    await registerClient(clientA, "preview-client-a");
    clientA.send(JSON.stringify({ type: "proxy_select", proxyId: "preview-proxy" }));
    const selectedA = JSON.parse(await waitForMessage(clientA)) as {
      proxyId: string;
      bindingId: string;
    };

    const clientB = connect("/client");
    await waitForOpen(clientB);
    await registerClient(clientB, "preview-client-b");
    clientB.send(JSON.stringify({ type: "proxy_select", proxyId: "preview-proxy" }));
    const selectedB = JSON.parse(await waitForMessage(clientB)) as {
      proxyId: string;
      bindingId: string;
    };

    const scopeA = { proxyId: selectedA.proxyId, bindingId: selectedA.bindingId };
    const scopeB = { proxyId: selectedB.proxyId, bindingId: selectedB.bindingId };
    expect(scopeA).toEqual({ proxyId: "preview-proxy", bindingId: expect.any(String) });
    expect(scopeB).toEqual({ proxyId: "preview-proxy", bindingId: expect.any(String) });
    return { proxy, clientA, clientB, scopeA, scopeB };
  }

  function recordJson(ws: WebSocket): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    return messages;
  }

  it("rewrites colliding request IDs and returns responses only to their requesting sockets", async () => {
    const { proxy, clientA, clientB, scopeA, scopeB } = await setup();
    const proxyRequestsPromise = collectMessages(proxy, 2, 1_000);
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    clientA.send(
      JSON.stringify({
        type: "preview_create_request",
        requestId: "same-client-request",
        scope: scopeA,
        operationId: "operation-a",
        tunnelProvider: "cloudflare",
        source: { kind: "local", url: "http://localhost:5173" },
      }),
    );
    clientB.send(
      JSON.stringify({
        type: "preview_create_request",
        requestId: "same-client-request",
        scope: scopeB,
        operationId: "operation-b",
        tunnelProvider: "cpolar",
        source: { kind: "static", path: "./output", entryPath: "index.html" },
      }),
    );

    const proxyRequests = (await proxyRequestsPromise).map((raw) => JSON.parse(raw));
    const requestA = proxyRequests.find((message) => message.operationId === "operation-a");
    const requestB = proxyRequests.find((message) => message.operationId === "operation-b");
    expect(requestA.requestId).toMatch(/^relay-preview-/);
    expect(requestB.requestId).toMatch(/^relay-preview-/);
    expect(requestA.requestId).not.toBe(requestB.requestId);
    expect(requestA.scope).toEqual(scopeA);
    expect(requestB.scope).toEqual(scopeB);

    // Proxy responses may finish in any order. Relay-owned request IDs still route them exactly.
    proxy.send(
      JSON.stringify({
        type: "preview_create_response",
        requestId: requestB.requestId,
        scope: untrustedProxyScope,
        operationId: "operation-b",
        accepted: true,
        previewId: "preview-b",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "preview_create_response",
        requestId: requestA.requestId,
        scope: untrustedProxyScope,
        operationId: "operation-a",
        accepted: true,
        previewId: "preview-a",
      }),
    );
    await settle(100);

    expect(receivedByA).toEqual([
      expect.objectContaining({
        type: "preview_create_response",
        requestId: "same-client-request",
        operationId: "operation-a",
        previewId: "preview-a",
        scope: scopeA,
      }),
    ]);
    expect(receivedByB).toEqual([
      expect.objectContaining({
        type: "preview_create_response",
        requestId: "same-client-request",
        operationId: "operation-b",
        previewId: "preview-b",
        scope: scopeB,
      }),
    ]);
  });

  it("routes scoped Web capability requests and strict responses", async () => {
    const { proxy, clientA, scopeA } = await setup();
    const forwardedPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "preview_capability_request",
        requestId: "capability-client-request",
        scope: scopeA,
        refreshPath: false,
      }),
    );

    const forwarded = JSON.parse(await forwardedPromise);
    expect(forwarded).toMatchObject({
      type: "preview_capability_request",
      requestId: expect.stringMatching(/^relay-preview-/),
      scope: scopeA,
      refreshPath: false,
    });

    const responsePromise = waitForMessageType(clientA, "preview_capability_response");
    proxy.send(
      JSON.stringify({
        type: "preview_capability_response",
        requestId: forwarded.requestId,
        scope: untrustedProxyScope,
        success: true,
        capability: {
          cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
          cpolar: { available: false, error: "Cpolar not found" },
        },
      }),
    );

    expect(JSON.parse(await responsePromise)).toEqual({
      type: "preview_capability_response",
      requestId: "capability-client-request",
      scope: scopeA,
      success: true,
      capability: {
        cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
        cpolar: { available: false, error: "Cpolar not found" },
      },
    });
  });

  it("returns a typed capability failure when the bound Proxy is offline", async () => {
    const { proxy, clientA, scopeA } = await setup();
    const closed = new Promise<void>((resolve) => proxy.once("close", () => resolve()));
    proxy.close();
    await closed;

    const responsePromise = waitForMessageType(clientA, "preview_capability_response");
    clientA.send(
      JSON.stringify({
        type: "preview_capability_request",
        requestId: "offline-capability",
        scope: scopeA,
        refreshPath: false,
      }),
    );

    expect(JSON.parse(await responsePromise)).toEqual({
      type: "preview_capability_response",
      requestId: "offline-capability",
      scope: scopeA,
      success: false,
      error: "开发机 preview-proxy 不在线",
      errorCode: "PROXY_OFFLINE",
    });
  });

  it("preserves operationId while rewriting rename request IDs", async () => {
    const { proxy, clientA, scopeA } = await setup();
    const forwardedPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "preview_rename_request",
        requestId: "rename-client-request",
        scope: scopeA,
        operationId: "rename-operation-1",
        previewId: "preview-1",
        name: "Product demo",
      }),
    );
    const forwarded = JSON.parse(await forwardedPromise);
    expect(forwarded).toMatchObject({
      type: "preview_rename_request",
      requestId: expect.stringMatching(/^relay-preview-/),
      operationId: "rename-operation-1",
    });

    const responsePromise = waitForMessageType(clientA, "preview_rename_response");
    proxy.send(
      JSON.stringify({
        type: "preview_rename_response",
        requestId: forwarded.requestId,
        scope: untrustedProxyScope,
        operationId: forwarded.operationId,
        previewId: "preview-1",
        success: true,
      }),
    );
    expect(JSON.parse(await responsePromise)).toMatchObject({
      requestId: "rename-client-request",
      operationId: "rename-operation-1",
      success: true,
      scope: scopeA,
    });
  });

  it("broadcasts state pushes while keeping list responses request-scoped", async () => {
    const { proxy, clientA, clientB, scopeA, scopeB } = await setup();
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({ type: "preview_list_request", requestId: "list-a", scope: scopeA }),
    );
    const proxyRequest = JSON.parse(await proxyRequestPromise);
    proxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: proxyRequest.requestId,
        scope: untrustedProxyScope,
        epoch: "epoch-1",
        revision: 0,
        previews: [],
      }),
    );
    await settle(50);

    expect(receivedByA).toEqual([
      expect.objectContaining({ type: "preview_list_response", requestId: "list-a" }),
    ]);
    expect(receivedByB).toEqual([]);

    proxy.send(
      JSON.stringify({
        type: "preview_state_event",
        epoch: "epoch-1",
        revision: 1,
        preview: {
          previewId: "preview-1",
          name: "localhost:5173",
          source: { kind: "local", url: "http://localhost:5173" },
          state: "starting",
          tunnelProvider: "cloudflare",
          createdAt: 100,
          updatedAt: 100,
        },
      }),
    );
    await settle(50);

    expect(receivedByA.at(-1)).toMatchObject({
      type: "preview_state_push",
      scope: scopeA,
      revision: 1,
    });
    expect(receivedByB).toEqual([
      expect.objectContaining({ type: "preview_state_push", scope: scopeB, revision: 1 }),
    ]);
  });

  it("drops unmatched and wrong-type responses instead of broadcasting them", async () => {
    const { proxy, clientA, clientB, scopeA } = await setup();
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    proxy.send(
      JSON.stringify({
        type: "preview_close_response",
        requestId: "never-requested",
        scope: untrustedProxyScope,
        operationId: "never-requested-operation",
        previewId: "preview-1",
        success: true,
      }),
    );
    await settle(50);
    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([]);

    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({ type: "preview_list_request", requestId: "list-a", scope: scopeA }),
    );
    const proxyRequest = JSON.parse(await proxyRequestPromise);
    proxy.send(
      JSON.stringify({
        type: "preview_close_response",
        requestId: proxyRequest.requestId,
        scope: untrustedProxyScope,
        operationId: "wrong-response-operation",
        previewId: "preview-1",
        success: true,
      }),
    );
    await settle(50);
    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([]);

    proxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: proxyRequest.requestId,
        scope: untrustedProxyScope,
        epoch: "epoch-1",
        revision: 0,
        previews: [],
      }),
    );
    await settle(50);
    expect(receivedByA).toEqual([
      expect.objectContaining({ type: "preview_list_response", requestId: "list-a" }),
    ]);
    expect(receivedByB).toEqual([]);
  });

  it("drops a late response after its requesting client disconnects", async () => {
    const { proxy, clientA, clientB, scopeA } = await setup();
    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "preview_close_request",
        requestId: "close-abandoned",
        scope: scopeA,
        operationId: "close-abandoned-operation",
        previewId: "preview-1",
      }),
    );
    const proxyRequest = JSON.parse(await proxyRequestPromise);
    const receivedByB = recordJson(clientB);

    await new Promise<void>((resolve) => {
      clientA.once("close", () => resolve());
      clientA.close();
    });
    proxy.send(
      JSON.stringify({
        type: "preview_close_response",
        requestId: proxyRequest.requestId,
        scope: untrustedProxyScope,
        operationId: "close-abandoned-operation",
        previewId: "preview-1",
        success: true,
      }),
    );
    await settle(100);

    expect(receivedByB).toEqual([]);
  });

  it("drops a pending response from the previously bound Proxy after rebinding", async () => {
    const { proxy: oldProxy, clientA, scopeA } = await setup();
    const newProxy = connect("/proxy");
    await waitForOpen(newProxy);
    const newProxyRegistered = waitForMessage(newProxy);
    newProxy.send(JSON.stringify({ type: "proxy_register", proxyId: "preview-proxy-new" }));
    await newProxyRegistered;

    const oldRequestPromise = waitForMessage(oldProxy);
    clientA.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "list-before-switch",
        scope: scopeA,
      }),
    );
    const oldRequest = JSON.parse(await oldRequestPromise);

    const selectResponse = waitForMessageType(clientA, "proxy_select_response");
    clientA.send(
      JSON.stringify({
        type: "proxy_select",
        requestId: "select-new-proxy",
        proxyId: "preview-proxy-new",
      }),
    );
    const selected = JSON.parse(await selectResponse) as {
      requestId: string;
      success: boolean;
      proxyId: string;
      bindingId: string;
    };
    expect(selected).toMatchObject({
      requestId: "select-new-proxy",
      success: true,
      proxyId: "preview-proxy-new",
      bindingId: expect.any(String),
    });
    const newScope = { proxyId: selected.proxyId, bindingId: selected.bindingId };

    const receivedAfterSwitch = recordJson(clientA);
    oldProxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: oldRequest.requestId,
        scope: untrustedProxyScope,
        epoch: "old-epoch",
        revision: 1,
        previews: [],
      }),
    );
    await settle(50);
    expect(
      receivedAfterSwitch.filter((message) => message.type === "preview_list_response"),
    ).toEqual([]);

    const newRequestPromise = waitForMessage(newProxy);
    clientA.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "list-after-switch",
        scope: newScope,
      }),
    );
    const newRequest = JSON.parse(await newRequestPromise);
    newProxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: newRequest.requestId,
        scope: untrustedProxyScope,
        epoch: "new-epoch",
        revision: 0,
        previews: [],
      }),
    );
    await settle(50);
    expect(
      receivedAfterSwitch.filter((message) => message.type === "preview_list_response"),
    ).toEqual([
      expect.objectContaining({
        type: "preview_list_response",
        requestId: "list-after-switch",
        epoch: "new-epoch",
        scope: newScope,
      }),
    ]);
  });

  it("rejects Preview requests without an authoritative binding before Proxy routing", async () => {
    const proxy = connect("/proxy");
    await waitForOpen(proxy);
    const registered = waitForMessage(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "preview-proxy" }));
    await registered;
    const receivedByProxy = recordJson(proxy);

    const client = connect("/client");
    await waitForOpen(client);
    await registerClient(client, "unbound-preview-client");
    const relayError = waitForMessage(client);
    client.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "list-unbound",
        scope: { proxyId: "preview-proxy", bindingId: "never-bound" },
      }),
    );

    expect(JSON.parse(await relayError)).toMatchObject({
      type: "relay_error",
      requestId: "list-unbound",
      code: "STALE_BINDING",
    });
    await settle(50);
    expect(receivedByProxy).toEqual([]);
  });

  it("rotates binding generation on same-Proxy select and never forwards the stale scope", async () => {
    const { proxy, clientA, scopeA } = await setup();
    const selectResponsePromise = waitForMessageType(clientA, "proxy_select_response");
    clientA.send(
      JSON.stringify({
        type: "proxy_select",
        requestId: "select-same-proxy",
        proxyId: "preview-proxy",
      }),
    );
    const selected = JSON.parse(await selectResponsePromise) as {
      proxyId: string;
      bindingId: string;
    };
    expect(selected.bindingId).not.toBe(scopeA.bindingId);

    const receivedByProxy = recordJson(proxy);
    const staleError = waitForMessageType(clientA, "relay_error");
    clientA.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "stale-list",
        scope: scopeA,
      }),
    );
    expect(JSON.parse(await staleError)).toMatchObject({
      requestId: "stale-list",
      code: "STALE_BINDING",
    });
    await settle(50);
    expect(receivedByProxy).toEqual([]);

    const currentScope = { proxyId: selected.proxyId, bindingId: selected.bindingId };
    const forwarded = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "current-list",
        scope: currentScope,
      }),
    );
    expect(JSON.parse(await forwarded)).toMatchObject({
      type: "preview_list_request",
      scope: currentScope,
    });
  });

  it("rejects Preview requests from a superseded client socket", async () => {
    const { proxy, clientA: previousClient, scopeA: previousScope } = await setup();
    const replacementClient = connect("/client");
    await waitForOpen(replacementClient);
    const registerResponse = waitForMessageType(replacementClient, "client_register_response");
    replacementClient.send(
      JSON.stringify({
        type: "client_register",
        clientId: "preview-client-a",
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
      }),
    );
    const restored = JSON.parse(await registerResponse) as {
      proxyId: string;
      bindingId: string;
    };
    expect(restored.bindingId).not.toBe(previousScope.bindingId);

    const receivedByProxy = recordJson(proxy);
    const staleError = waitForMessageType(previousClient, "relay_error");
    previousClient.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "superseded-socket-list",
        scope: previousScope,
      }),
    );
    expect(JSON.parse(await staleError)).toMatchObject({
      requestId: "superseded-socket-list",
      code: "STALE_BINDING",
    });
    await settle(50);
    expect(receivedByProxy).toEqual([]);

    const replacementScope = { proxyId: restored.proxyId, bindingId: restored.bindingId };
    const forwarded = waitForMessage(proxy);
    replacementClient.send(
      JSON.stringify({
        type: "preview_list_request",
        requestId: "replacement-socket-list",
        scope: replacementScope,
      }),
    );
    expect(JSON.parse(await forwarded)).toMatchObject({
      type: "preview_list_request",
      scope: replacementScope,
    });
  });
});
