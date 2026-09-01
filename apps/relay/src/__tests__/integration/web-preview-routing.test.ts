import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
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
    await waitForMessage(clientA);

    const clientB = connect("/client");
    await waitForOpen(clientB);
    await registerClient(clientB, "preview-client-b");
    clientB.send(JSON.stringify({ type: "proxy_select", proxyId: "preview-proxy" }));
    await waitForMessage(clientB);

    return { proxy, clientA, clientB };
  }

  function recordJson(ws: WebSocket): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    return messages;
  }

  it("rewrites colliding request IDs and returns responses only to their requesting sockets", async () => {
    const { proxy, clientA, clientB } = await setup();
    const proxyRequestsPromise = collectMessages(proxy, 2, 1_000);
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    clientA.send(
      JSON.stringify({
        type: "preview_create_request",
        requestId: "same-client-request",
        operationId: "operation-a",
        tunnelProvider: "cloudflare",
        source: { kind: "local", url: "http://localhost:5173" },
      }),
    );
    clientB.send(
      JSON.stringify({
        type: "preview_create_request",
        requestId: "same-client-request",
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

    // Proxy responses may finish in any order. Relay-owned request IDs still route them exactly.
    proxy.send(
      JSON.stringify({
        type: "preview_create_response",
        requestId: requestB.requestId,
        operationId: "operation-b",
        accepted: true,
        previewId: "preview-b",
      }),
    );
    proxy.send(
      JSON.stringify({
        type: "preview_create_response",
        requestId: requestA.requestId,
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
      }),
    ]);
    expect(receivedByB).toEqual([
      expect.objectContaining({
        type: "preview_create_response",
        requestId: "same-client-request",
        operationId: "operation-b",
        previewId: "preview-b",
      }),
    ]);
  });

  it("broadcasts state pushes while keeping list responses request-scoped", async () => {
    const { proxy, clientA, clientB } = await setup();
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(JSON.stringify({ type: "preview_list_request", requestId: "list-a" }));
    const proxyRequest = JSON.parse(await proxyRequestPromise);
    proxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: proxyRequest.requestId,
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
        type: "preview_state_push",
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

    expect(receivedByA.at(-1)).toMatchObject({ type: "preview_state_push", revision: 1 });
    expect(receivedByB).toEqual([
      expect.objectContaining({ type: "preview_state_push", revision: 1 }),
    ]);
  });

  it("drops unmatched and wrong-type responses instead of broadcasting them", async () => {
    const { proxy, clientA, clientB } = await setup();
    const receivedByA = recordJson(clientA);
    const receivedByB = recordJson(clientB);

    proxy.send(
      JSON.stringify({
        type: "preview_close_response",
        requestId: "never-requested",
        previewId: "preview-1",
        success: true,
      }),
    );
    await settle(50);
    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([]);

    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(JSON.stringify({ type: "preview_list_request", requestId: "list-a" }));
    const proxyRequest = JSON.parse(await proxyRequestPromise);
    proxy.send(
      JSON.stringify({
        type: "preview_close_response",
        requestId: proxyRequest.requestId,
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
    const { proxy, clientA, clientB } = await setup();
    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "preview_close_request",
        requestId: "close-abandoned",
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
        previewId: "preview-1",
        success: true,
      }),
    );
    await settle(100);

    expect(receivedByB).toEqual([]);
  });

  it("drops a pending response from the previously bound Proxy after rebinding", async () => {
    const { proxy: oldProxy, clientA } = await setup();
    const newProxy = connect("/proxy");
    await waitForOpen(newProxy);
    const newProxyRegistered = waitForMessage(newProxy);
    newProxy.send(JSON.stringify({ type: "proxy_register", proxyId: "preview-proxy-new" }));
    await newProxyRegistered;

    const oldRequestPromise = waitForMessage(oldProxy);
    clientA.send(JSON.stringify({ type: "preview_list_request", requestId: "list-before-switch" }));
    const oldRequest = JSON.parse(await oldRequestPromise);

    const selectResponse = waitForMessageType(clientA, "proxy_select_response");
    clientA.send(
      JSON.stringify({
        type: "proxy_select",
        requestId: "select-new-proxy",
        proxyId: "preview-proxy-new",
      }),
    );
    expect(JSON.parse(await selectResponse)).toMatchObject({
      requestId: "select-new-proxy",
      success: true,
      proxyId: "preview-proxy-new",
    });

    const receivedAfterSwitch = recordJson(clientA);
    oldProxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: oldRequest.requestId,
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
    clientA.send(JSON.stringify({ type: "preview_list_request", requestId: "list-after-switch" }));
    const newRequest = JSON.parse(await newRequestPromise);
    newProxy.send(
      JSON.stringify({
        type: "preview_list_response",
        requestId: newRequest.requestId,
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
      }),
    ]);
  });

  it("rejects preview requests from an unbound client before they reach a Proxy", async () => {
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
    client.send(JSON.stringify({ type: "preview_list_request", requestId: "list-unbound" }));

    expect(JSON.parse(await relayError)).toMatchObject({
      type: "relay_error",
      requestId: "list-unbound",
      code: "NOT_BOUND",
    });
    await settle(50);
    expect(receivedByProxy).toEqual([]);
  });
});
