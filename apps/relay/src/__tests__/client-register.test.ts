import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "../server.js";
import { WebSocket } from "ws";
import pino from "pino";

const logger = pino({ level: "silent" });

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data.toString()));
  });
}

// 收集指定数量的消息
function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", onMessage);
      resolve(messages);
    }, timeoutMs);

    function onMessage(data: { toString(): string }) {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        resolve(messages);
      }
    }
    ws.on("message", onMessage);
  });
}

function getPort(server: RelayServer): number {
  const addr = server.httpServer.address();
  if (typeof addr === "object" && addr !== null) {
    return addr.port;
  }
  throw new Error("Server not listening");
}

describe("client_register protocol", () => {
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

  // 等待处理完成
  const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  it("returns status 'new' for unknown clientId", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({
      type: "client_register",
      clientId: "fresh-client",
      lastSeq: 0,
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.status).toBe("new");
    expect(response.proxyId).toBeUndefined();
  });

  it("returns status 'restored' with proxyId for known client with online proxy", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // 第一个客户端连接并绑定
    const client1 = connectClient();
    await waitForOpen(client1);
    client1.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 0,
    }));
    // 收到 new 因为没有绑定
    const newResponse = JSON.parse(await waitForMessage(client1));
    expect(newResponse.status).toBe("new");

    // 通过 proxy_select 绑定到 proxy
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // 断开第一个客户端
    client1.close();
    await settle();

    // 第二个客户端使用同一 clientId 重连
    const client2 = connectClient();
    await waitForOpen(client2);
    connections.push(client2);

    const msgPromise = waitForMessage(client2);
    client2.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 0,
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.status).toBe("restored");
    expect(response.proxyId).toBe("p1");
  });

  it("streams missed messages after 'restored' response", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // 客户端连接、注册并绑定
    const client1 = connectClient();
    await waitForOpen(client1);
    client1.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 0,
    }));
    await waitForMessage(client1); // new response
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // Proxy 发送 3 条消息
    const makeEnvelope = (seq: number) => ({
      seq,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "proxy" as const,
      version: "1.0",
      type: "assistant_message" as const,
      payload: { text: `msg-${seq}`, isPartial: false },
    });

    // 客户端在线时收到这些消息
    const client1Messages = collectMessages(client1, 3);
    proxy.send(JSON.stringify(makeEnvelope(1)));
    proxy.send(JSON.stringify(makeEnvelope(2)));
    proxy.send(JSON.stringify(makeEnvelope(3)));
    await client1Messages;

    // 断开客户端（假设收到了 seq 1）
    client1.close();
    await settle();

    // 新客户端重连，lastSeq=1 表示需要 seq 2, 3
    const client2 = connectClient();
    await waitForOpen(client2);
    connections.push(client2);

    // 收集 restored response + 2 条回放消息
    const allMessages = collectMessages(client2, 3);
    client2.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 1,
    }));

    const received = await allMessages;
    expect(received.length).toBe(3);

    // 第一条是 restored response
    const restored = JSON.parse(received[0]);
    expect(restored.type).toBe("client_register_response");
    expect(restored.status).toBe("restored");

    // 后续是回放的消息（各自独立帧，不是数组）
    const replay1 = JSON.parse(received[1]);
    expect(replay1.seq).toBe(2);
    expect(replay1.payload.text).toBe("msg-2");

    const replay2 = JSON.parse(received[2]);
    expect(replay2.seq).toBe(3);
    expect(replay2.payload.text).toBe("msg-3");
  });

  it("returns status 'proxy_offline' when proxy is in grace period", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // 客户端绑定
    const client1 = connectClient();
    await waitForOpen(client1);
    client1.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 0,
    }));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // 断开客户端和 proxy
    client1.close();
    await settle();
    proxy.close();
    await settle(100); // 等待 grace period 启动

    // 新客户端重连
    const client2 = connectClient();
    await waitForOpen(client2);
    connections.push(client2);

    const msgPromise = waitForMessage(client2);
    client2.send(JSON.stringify({
      type: "client_register",
      clientId: "c1",
      lastSeq: 0,
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.status).toBe("proxy_offline");
    expect(response.proxyId).toBe("p1");
  });

  it("sends PROXY_OFFLINE error when client sends envelope during grace period", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // 客户端绑定
    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // Proxy 断开进入宽限期
    proxy.close();
    await settle(100);

    // 客户端发送 envelope
    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({
      seq: 1,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "client" as const,
      version: "1.0",
      type: "user_input" as const,
      payload: { text: "hello" },
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("PROXY_OFFLINE");
  });

  it("proxy_select rejects binding to offline proxy in grace period", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // proxy 断线进入宽限期
    proxy.close();
    await settle(100);

    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("PROXY_NOT_FOUND");
  });

  it("proxy_select rejects binding to nonexistent proxy", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "nonexistent" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("PROXY_NOT_FOUND");
  });

  it("client receives proxy_offline on proxy graceful disconnect", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // proxy 主动退出
    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({ type: "proxy_disconnect", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_offline");
    expect(response.proxyId).toBe("p1");
  });

  it("client receives proxy_online when proxy reconnects after grace period", async () => {
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // proxy 异常断线
    const offlinePromise = waitForMessage(client);
    proxy1.close();
    const offlineMsg = JSON.parse(await offlinePromise);
    expect(offlineMsg.type).toBe("proxy_offline");

    // proxy 重连
    const onlinePromise = waitForMessage(client);
    const proxy2 = connectProxy();
    await waitForOpen(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));

    const onlineMsg = JSON.parse(await onlinePromise);
    expect(onlineMsg.type).toBe("proxy_online");
    expect(onlineMsg.proxyId).toBe("p1");
  });

  it("proxy_select still works for clients without client_register", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // proxy -> client 应该工作
    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      seq: 1,
      sessionId: "s1",
      timestamp: Date.now(),
      source: "proxy" as const,
      version: "1.0",
      type: "assistant_message" as const,
      payload: { text: "hello", isPartial: false },
    }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe("assistant_message");
    expect(msg.payload.text).toBe("hello");
  });

  it("proxy receives proxy_register_response with status 'new' on first register", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);

    const msgPromise = waitForMessage(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.status).toBe("new");
    expect(response.sessions).toBeUndefined();
  });

  it("proxy receives proxy_register_response with status 'reconnected' and session seq map", async () => {
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy1); // consume register response
    await settle();

    // proxy 发送消息填充 buffer
    proxy1.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(),
      source: "proxy" as const, version: "1.0",
      type: "assistant_message" as const,
      payload: { text: "msg-1", isPartial: false },
    }));
    proxy1.send(JSON.stringify({
      seq: 5, sessionId: "s1", timestamp: Date.now(),
      source: "proxy" as const, version: "1.0",
      type: "assistant_message" as const,
      payload: { text: "msg-5", isPartial: false },
    }));
    await settle();

    // proxy 断线
    proxy1.close();
    await settle(100);

    // proxy 重连
    const proxy2 = connectProxy();
    await waitForOpen(proxy2);

    const msgPromise = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.status).toBe("reconnected");
    expect(response.sessions).toBeDefined();
    expect(response.sessions.s1).toBe(5);
  });
});
