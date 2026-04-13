import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@cc-anywhere/shared";
import { waitForOpen, waitForMessage, getPort } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("Relay Server Integration", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  beforeEach(async () => {
    relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    port = getPort(relay);
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    connections.length = 0;
    await relay.close();
  });

  function connectProxy(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    connections.push(ws);
    return ws;
  }

  function connectClient(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    connections.push(ws);
    return ws;
  }

  it("proxy connects and registers", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);

    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "test-proxy" }));
    // 等待注册处理完毕
    await new Promise((r) => setTimeout(r, 50));

    expect(relay.registry.listProxies()).toContain("test-proxy");
  });

  it("client sends proxy_list_request and receives response", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await new Promise((r) => setTimeout(r, 50));

    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));
    const response = JSON.parse(await msgPromise);

    expect(response.type).toBe("proxy_list_response");
    expect(response.proxies).toEqual([{ proxyId: "p1", online: true }]);
  });

  it("client selects proxy and messages route bidirectionally", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await new Promise((r) => setTimeout(r, 50));

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await new Promise((r) => setTimeout(r, 50));

    // proxy -> client
    const clientMsgPromise = waitForMessage(client);
    const envelope = {
      seq: 1,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "proxy",
      version: "1.0",
      type: "assistant_message",
      payload: { text: "hello from proxy", isPartial: false },
    };
    proxy.send(JSON.stringify(envelope));
    const received = JSON.parse(await clientMsgPromise);
    expect(received.type).toBe("assistant_message");
    expect(received.payload.text).toBe("hello from proxy");

    // client -> proxy
    const proxyMsgPromise = waitForMessage(proxy);
    const clientEnvelope = {
      seq: 2,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "client",
      version: "1.0",
      type: "user_input",
      payload: { text: "hello from client" },
    };
    client.send(JSON.stringify(clientEnvelope));
    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("user_input");
    expect(proxyReceived.payload.text).toBe("hello from client");
  });

  it("client gets error when selecting non-existent proxy", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "nonexistent" }));
    const response = JSON.parse(await msgPromise);

    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("PROXY_NOT_FOUND");
  });

  it("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  it("GET /status returns proxy and client counts", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proxyCount: number; clientCount: number; uptime: number };
    expect(body.proxyCount).toBe(1);
    expect(typeof body.clientCount).toBe("number");
    expect(typeof body.uptime).toBe("number");
  });

  it("marks proxy offline when proxy disconnects, state preserved", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.registry.listProxies()).toContain("p1");

    proxy.close();
    await new Promise((r) => setTimeout(r, 100));
    // proxy 断连后标记离线，状态永久保留等待重连
    expect(relay.registry.listProxies()).toContain("p1");
    expect(relay.registry.isProxyOnline("p1")).toBe(false);
  });

  it("rejects WebSocket upgrade on unknown path", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/unknown`);
    connections.push(ws);

    await new Promise<void>((resolve) => {
      ws.on("error", () => resolve());
      ws.on("close", () => resolve());
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe("Relay Server Heartbeat", () => {
  it("detects and cleans up dead connections", async () => {
    const relay = createRelayServer({
      port: 0,
      heartbeatInterval: 100,
      logger,
    });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    const addr = relay.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const proxy = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "hb-test" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.registry.listProxies()).toContain("hb-test");

    // 禁用 pong 响应来模拟死连接
    proxy.pong = () => {};
    proxy.on("ping", () => {
      // 不回复 pong
    });

    // 等待两个心跳周期让死连接被终止并标记离线
    await new Promise((r) => setTimeout(r, 350));
    // 死连接被 terminate 后标记离线，proxyId 仍在列表但不在线
    expect(relay.registry.listProxies()).toContain("hb-test");
    expect(relay.registry.isProxyOnline("hb-test")).toBe(false);

    proxy.close();
    await relay.close();
  });
});
