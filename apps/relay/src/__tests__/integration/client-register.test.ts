import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { RelayCloseCode } from "@dev-anywhere/shared";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  waitForOpen,
  waitForMessage,
  waitForMessageType,
  collectMessages,
  getPort,
  settle,
} from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

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

  function clientRegister(clientId: string): Record<string, unknown> {
    return {
      type: "client_register",
      clientId,
      browserName: "Chrome",
      osName: "macOS",
      deviceKind: "desktop",
    };
  }

  it("returns status 'new' for unknown clientId", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify(clientRegister("fresh-client")));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.status).toBe("new");
    expect(response.proxyId).toBeUndefined();
  });

  it("rejects incomplete client_register without device descriptor", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    client.send(JSON.stringify({ type: "client_register", clientId: "old-client" }));

    const response = JSON.parse(await msgPromise);
    expect(response).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_PROTOCOL_REJECTED);
  });

  it("lists connected relay clients and lets one client kick another", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client1 = connectClient();
    await waitForOpen(client1);
    client1.send(JSON.stringify(clientRegister("c1")));
    await waitForMessageType(client1, "client_register_response");
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessageType(client1, "proxy_select_response");

    const client2 = connectClient();
    await waitForOpen(client2);
    client2.send(
      JSON.stringify({
        type: "client_register",
        clientId: "c2",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
        browserName: "Safari",
        osName: "iPad",
        deviceKind: "tablet",
      }),
    );
    await waitForMessageType(client2, "client_register_response");

    const listPromise = waitForMessageType(client1, "relay_client_list_response");
    client1.send(JSON.stringify({ type: "relay_client_list_request", requestId: "clients-1" }));
    const listResponse = JSON.parse(await listPromise);
    expect(listResponse.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: "c1", proxyId: "p1", current: true }),
        expect.objectContaining({
          clientId: "c2",
          platform: "MacIntel",
          maxTouchPoints: 5,
          browserName: "Safari",
          osName: "iPad",
          deviceKind: "tablet",
        }),
      ]),
    );

    const kickedPromise = waitForMessageType(client2, "relay_client_kicked");
    const closePromise = new Promise<number>((resolve) => {
      client2.once("close", (code) => resolve(code));
    });
    const kickResponsePromise = waitForMessageType(client1, "relay_client_kick_response");
    client1.send(
      JSON.stringify({ type: "relay_client_kick", requestId: "kick-1", clientId: "c2" }),
    );

    const kickResponse = JSON.parse(await kickResponsePromise);
    expect(kickResponse).toMatchObject({
      type: "relay_client_kick_response",
      requestId: "kick-1",
      clientId: "c2",
      success: true,
    });
    expect(JSON.parse(await kickedPromise)).toMatchObject({ type: "relay_client_kicked" });
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_KICKED);
  });

  it("rejects relay client self-kick", async () => {
    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify(clientRegister("c1")));
    await waitForMessageType(client, "client_register_response");

    const responsePromise = waitForMessageType(client, "relay_client_kick_response");
    client.send(
      JSON.stringify({ type: "relay_client_kick", requestId: "kick-self", clientId: "c1" }),
    );

    expect(JSON.parse(await responsePromise)).toMatchObject({
      type: "relay_client_kick_response",
      requestId: "kick-self",
      clientId: "c1",
      success: false,
      error: "不能断开当前客户端",
    });
    expect(client.readyState).toBe(WebSocket.OPEN);
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
    client1.send(JSON.stringify(clientRegister("c1")));
    // 新 client 没有绑定，收到 new
    const newResponse = JSON.parse(await waitForMessage(client1));
    expect(newResponse.status).toBe("new");

    // 通过 proxy_select 绑定到 proxy
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client1); // consume proxy_select_response ACK

    // 断开第一个客户端
    client1.close();
    await settle();

    // 第二个客户端使用同一 clientId 重连
    const client2 = connectClient();
    await waitForOpen(client2);
    connections.push(client2);

    const msgPromise = waitForMessage(client2);
    client2.send(JSON.stringify(clientRegister("c1")));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.status).toBe("restored");
    expect(response.proxyId).toBe("p1");
  });

  it("returns restored without relay-side message replay", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    // 客户端连接、注册并绑定
    const client1 = connectClient();
    await waitForOpen(client1);
    client1.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client1); // new response
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client1); // consume proxy_select_response ACK

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

    // 断开客户端。relay 不保留消息 replay buffer，恢复后的会话内容由 proxy snapshot/list 类消息重推。
    client1.close();
    await settle();

    // 新客户端重连，s1 已收到到 seq 1，需要回放 seq 2, 3
    const client2 = connectClient();
    await waitForOpen(client2);
    connections.push(client2);

    const allMessages = collectMessages(client2, 1);
    client2.send(JSON.stringify(clientRegister("c1")));

    const received = await allMessages;
    expect(received.length).toBe(1);

    const restored = JSON.parse(received[0]);
    expect(restored.type).toBe("client_register_response");
    expect(restored.status).toBe("restored");
  });

  it("keeps the replacement socket bound when the previous socket closes late", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const previousClient = connectClient();
    await waitForOpen(previousClient);
    previousClient.send(JSON.stringify(clientRegister("c1")));
    await waitForMessageType(previousClient, "client_register_response");
    previousClient.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessageType(previousClient, "proxy_select_response");

    const replacementClient = connectClient();
    await waitForOpen(replacementClient);
    replacementClient.send(JSON.stringify(clientRegister("c1")));
    expect(
      JSON.parse(await waitForMessageType(replacementClient, "client_register_response")),
    ).toMatchObject({ status: "restored", proxyId: "p1" });

    const previousClosed = new Promise<void>((resolve) =>
      previousClient.once("close", () => resolve()),
    );
    previousClient.close();
    await previousClosed;

    const forwarded = waitForMessage(replacementClient);
    proxy.send(
      JSON.stringify({
        seq: 1,
        sessionId: "s1",
        timestamp: Date.now(),
        source: "proxy",
        version: "1.0",
        type: "assistant_message",
        payload: { text: "still connected", isPartial: false },
      }),
    );

    expect(JSON.parse(await forwarded)).toMatchObject({
      type: "assistant_message",
      payload: { text: "still connected" },
    });
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
    client1.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client1); // consume proxy_select_response ACK

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
    client2.send(JSON.stringify(clientRegister("c1")));

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
    client.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client); // consume client_register_response
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response ACK

    // Proxy 断开进入宽限期
    proxy.close();
    await settle(100);

    // 客户端发送 envelope
    const msgPromise = waitForMessage(client);
    client.send(
      JSON.stringify({
        seq: 1,
        sessionId: "s1",
        timestamp: Date.now(),
        source: "client" as const,
        version: "1.0",
        type: "user_input" as const,
        payload: { text: "hello" },
      }),
    );

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("PROXY_OFFLINE");
  });

  it("client receives proxy_offline on proxy graceful disconnect", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client); // consume client_register_response
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response ACK

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
    client.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client); // consume client_register_response
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response ACK

    // proxy 异常断线（跳过 broadcast 的 proxy_list_response）
    const offlinePromise = waitForMessageType(client, "proxy_offline");
    proxy1.close();
    const offlineMsg = JSON.parse(await offlinePromise);
    expect(offlineMsg.type).toBe("proxy_offline");

    // proxy 重连（跳过 broadcast 的 proxy_list_response）
    const onlinePromise = waitForMessageType(client, "proxy_online");
    const proxy2 = connectProxy();
    await waitForOpen(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));

    const onlineMsg = JSON.parse(await onlinePromise);
    expect(onlineMsg.type).toBe("proxy_online");
    expect(onlineMsg.proxyId).toBe("p1");
  });

  it("proxy_select returns proxy_select_response with success true", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);

    client.send(JSON.stringify(clientRegister("c1")));
    await waitForMessage(client); // consume client_register_response
    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_select_response");
    expect(response.success).toBe(true);
    expect(response.proxyId).toBe("p1");
  });

  it("proxy_list_response includes sessions per proxy", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy); // consume register response
    await settle();

    // proxy 发送 session_sync 注册 session
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [
          { id: "s1", mode: "pty", provider: "claude", state: "idle" },
          { id: "s2", mode: "json", provider: "claude", state: "working" },
        ],
      }),
    );
    await settle();

    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_list_response");
    expect(response.proxies).toHaveLength(1);
    expect(response.proxies[0].sessions).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("rejects proxy_select before client_register", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    const msgPromise = waitForMessage(client);
    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));

    const msg = JSON.parse(await msgPromise);
    expect(msg).toMatchObject({
      type: "relay_error",
      code: "NOT_REGISTERED",
    });
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_PROTOCOL_REJECTED);
  });

  it("proxy receives proxy_register_response with status 'new' on first register", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);

    const msgPromise = waitForMessage(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.status).toBe("new");
  });

  it("proxy receives proxy_register_response with status 'reconnected' on second register with same proxyId", async () => {
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy1); // consume register response
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
  });
});
