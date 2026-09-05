import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import {
  MESSAGE_ENVELOPE_VERSION,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayProtocolRejectReason,
} from "@dev-anywhere/shared";
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
      relay.httpServer.listen(0, "127.0.0.1", resolve);
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

  async function startRelayWithClientAdmissionTimeout(timeoutMs: number): Promise<{
    relay: RelayServer;
    port: number;
  }> {
    const timeoutRelay = createRelayServer({
      port: 0,
      heartbeatInterval: 60_000,
      clientAdmissionTimeoutMs: timeoutMs,
      logger,
    });
    await new Promise<void>((resolve) => {
      timeoutRelay.httpServer.listen(0, "127.0.0.1", resolve);
    });
    return { relay: timeoutRelay, port: getPort(timeoutRelay) };
  }

  function clientRegister(clientId: string): Record<string, unknown> {
    return {
      type: "client_register",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      clientId,
      browserName: "Chrome",
      osName: "macOS",
      deviceKind: "desktop",
    };
  }

  function proxyRegister(proxyId = "p1"): Record<string, unknown> {
    return {
      type: "proxy_register",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      proxyId,
      proxyVersion: "0.9.0",
    };
  }

  it("returns status 'new' for unknown clientId", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify(clientRegister("fresh-client")));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("client_register_response");
    expect(response.protocolVersion).toBe(RELAY_CONTROL_PROTOCOL_VERSION);
    expect(response.status).toBe("new");
    expect(response.proxyId).toBeUndefined();
    expect(response.bindingId).toBeUndefined();
  });

  it("accepts Proxy registration metadata without adopting it and continues routing", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const registered = waitForMessageType(proxy, "proxy_register_response");
    proxy.send(
      JSON.stringify({
        ...proxyRegister("extended-proxy"),
        name: "Development machine",
        metadata: { platform: "win32", proxyId: "forged-proxy" },
        connectionId: "forged-connection",
        sessions: ["forged-session"],
      }),
    );
    const registration = JSON.parse(await registered);
    expect(registration).toEqual({
      type: "proxy_register_response",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      status: "new",
      relayVersion: expect.any(String),
      connectionId: expect.any(String),
    });
    expect(registration.connectionId).not.toBe("forged-connection");
    expect(relay.registry.hasProxy("forged-proxy")).toBe(false);

    const client = connectClient();
    await waitForOpen(client);
    const clientRegistered = waitForMessageType(client, "client_register_response");
    client.send(JSON.stringify(clientRegister("proxy-metadata-observer")));
    await clientRegistered;

    const listed = waitForMessageType(client, "proxy_list_response");
    client.send(JSON.stringify({ type: "proxy_list_request", requestId: "metadata-proxies" }));
    expect(JSON.parse(await listed).proxies).toEqual([
      {
        proxyId: "extended-proxy",
        name: "Development machine",
        version: "0.9.0",
        online: true,
        sessions: [],
      },
    ]);

    const selected = waitForMessageType(client, "proxy_select_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "extended-proxy" }));
    expect(JSON.parse(await selected)).toMatchObject({ success: true });

    const requested = waitForMessageType(proxy, "session_list_request");
    client.send(JSON.stringify({ type: "session_list_request" }));
    expect(JSON.parse(await requested)).toEqual({ type: "session_list_request" });

    const delivered = waitForMessageType(client, "assistant_message");
    const message = {
      type: "assistant_message",
      version: MESSAGE_ENVELOPE_VERSION,
      source: "proxy",
      seq: 1,
      timestamp: Date.now(),
      sessionId: "actual-session",
      payload: { turnId: "turn-1", revision: 1, text: "hello", status: "completed" },
    };
    proxy.send(JSON.stringify(message));
    expect(JSON.parse(await delivered)).toEqual(message);
  });

  it("accepts client registration metadata without granting a supplied identity or binding", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const proxyRegistered = waitForMessageType(proxy, "proxy_register_response");
    proxy.send(JSON.stringify(proxyRegister()));
    await proxyRegistered;

    const client = connectClient();
    await waitForOpen(client);
    const registered = waitForMessageType(client, "client_register_response");
    client.send(
      JSON.stringify({
        ...clientRegister("extended-client"),
        metadata: { clientId: "forged-client", browserName: "Forged browser" },
        proxyId: "p1",
        boundProxyId: "p1",
        bindingId: "forged-binding",
        remoteAddress: "203.0.113.99",
      }),
    );
    expect(JSON.parse(await registered)).toEqual({
      type: "client_register_response",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      status: "new",
    });
    expect(relay.registry.getClientBinding("extended-client")).toBeUndefined();
    expect(relay.registry.getConnectedClientDetails()).toEqual([
      {
        clientId: "extended-client",
        connectedAt: expect.any(Number),
        browserName: "Chrome",
        osName: "macOS",
        deviceKind: "desktop",
        remoteAddress: "127.0.0.1",
      },
    ]);

    const unbound = waitForMessageType(client, "relay_error");
    client.send(JSON.stringify({ type: "session_list_request" }));
    expect(JSON.parse(await unbound)).toMatchObject({ code: "NOT_BOUND" });

    const selected = waitForMessageType(client, "proxy_select_response");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    const selection = JSON.parse(await selected);
    expect(selection).toMatchObject({
      success: true,
      proxyId: "p1",
      bindingId: expect.any(String),
    });
    expect(selection.bindingId).not.toBe("forged-binding");

    const requested = waitForMessageType(proxy, "session_list_request");
    client.send(JSON.stringify({ type: "session_list_request" }));
    expect(JSON.parse(await requested)).toEqual({ type: "session_list_request" });
  });

  it("does not broadcast proxy state to a raw client before its registration response", async () => {
    const client = connectClient();
    await waitForOpen(client);
    const earlyMessages: string[] = [];
    const collectEarly = (data: { toString(): string }) => earlyMessages.push(data.toString());
    client.on("message", collectEarly);

    const proxy = connectProxy();
    await waitForOpen(proxy);
    const proxyRegistered = waitForMessageType(proxy, "proxy_register_response");
    proxy.send(JSON.stringify(proxyRegister("proxy-during-client-admission")));
    await proxyRegistered;
    await settle(25);
    expect(earlyMessages).toEqual([]);

    client.off("message", collectEarly);
    const clientRegistered = waitForMessage(client);
    client.send(JSON.stringify(clientRegister("client-after-proxy-broadcast")));
    expect(JSON.parse(await clientRegistered)).toMatchObject({
      type: "client_register_response",
      status: "new",
    });
  });

  it("rejects incomplete client_register without device descriptor", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    client.send(
      JSON.stringify({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "incomplete-client",
      }),
    );

    const response = JSON.parse(await msgPromise);
    expect(response).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_PROTOCOL_REJECTED);
  });

  it("terminates an unversioned client with the permanent signal it already understands", async () => {
    const client = connectClient();
    await waitForOpen(client);
    const message = clientRegister("unversioned-client");
    delete message.protocolVersion;
    const messages: Array<Record<string, unknown>> = [];
    client.on("message", (data) => messages.push(JSON.parse(data.toString())));
    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });

    const obsoleteRegistration = JSON.stringify(message);
    client.send(obsoleteRegistration);
    client.send(obsoleteRegistration);

    // Unversioned Web clients only classify 4401 as terminal. 4402 would reopen immediately and
    // reset their retry budget on every successful HTTP upgrade.
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_KICKED);
    expect(messages).toEqual([
      {
        type: "relay_client_kicked",
        reason: "页面版本已更新，请刷新",
      },
    ]);
    expect(relay.registry.getClientDetails()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ clientId: message.clientId })]),
    );
  });

  it("closes an unregistered raw client after a retryable admission timeout", async () => {
    const timeoutServer = await startRelayWithClientAdmissionTimeout(100);
    const client = new WebSocket(`ws://127.0.0.1:${timeoutServer.port}/client`);
    try {
      await waitForOpen(client);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      await expect(closed).resolves.toEqual({
        code: 1013,
        reason: "client registration timeout",
      });
    } finally {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      }
      await timeoutServer.relay.close();
    }
  });

  it("cancels the admission timeout after a valid registration", async () => {
    const timeoutServer = await startRelayWithClientAdmissionTimeout(100);
    const client = new WebSocket(`ws://127.0.0.1:${timeoutServer.port}/client`);
    try {
      await waitForOpen(client);
      const registered = waitForMessageType(client, "client_register_response");
      client.send(JSON.stringify(clientRegister("admitted-before-timeout")));
      await registered;
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(client.readyState).toBe(WebSocket.OPEN);
    } finally {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      }
      await timeoutServer.relay.close();
    }
  });

  it.each([
    [0, RelayProtocolRejectReason.PROTOCOL_MISMATCH],
    [2, RelayProtocolRejectReason.SERVICE_OUTDATED],
  ])(
    "rejects control protocol %s with the machine-readable reason %s",
    async (protocolVersion, expectedReason) => {
      const client = connectClient();
      await waitForOpen(client);
      const message = clientRegister(`rejected-client-${String(protocolVersion)}`);
      message.protocolVersion = protocolVersion;
      const messages: string[] = [];
      client.on("message", (data) => messages.push(data.toString()));
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      client.send(JSON.stringify(message));

      expect(await closePromise).toEqual({
        code: RelayCloseCode.CLIENT_PROTOCOL_REJECTED,
        reason: expectedReason,
      });
      // Admission rejection stays in the stable WebSocket close layer. Sending a new JSON message
      // first would make an older page close locally before it can observe the permanent 4402.
      expect(messages).toEqual([]);
      expect(relay.registry.getClientDetails()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ clientId: message.clientId })]),
      );
    },
  );

  it("rejects an envelope before the current client handshake", async () => {
    const client = connectClient();
    await waitForOpen(client);
    const errorPromise = waitForMessageType(client, "relay_error");
    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });

    client.send(
      JSON.stringify({
        type: "heartbeat",
        seq: 0,
        timestamp: 1,
        source: "client",
        version: MESSAGE_ENVELOPE_VERSION,
        payload: {},
      }),
    );

    expect(JSON.parse(await errorPromise)).toMatchObject({ code: "NOT_REGISTERED" });
    expect(await closePromise).toBe(RelayCloseCode.CLIENT_PROTOCOL_REJECTED);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", 0],
  ])("rejects a Proxy with a %s control protocol", async (_label, protocolVersion) => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    const message = proxyRegister(`rejected-proxy-${String(protocolVersion)}`);
    if (protocolVersion === undefined) delete message.protocolVersion;
    else message.protocolVersion = protocolVersion;
    const messages: string[] = [];
    proxy.on("message", (data) => messages.push(data.toString()));
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      proxy.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    proxy.send(JSON.stringify(message));

    expect(await closePromise).toEqual({
      code: RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      reason: "protocol_mismatch",
    });
    expect(messages).toEqual([]);
    expect(relay.registry.hasProxy(String(message.proxyId))).toBe(false);
  });

  it("lists connected relay clients and lets one client kick another", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister()));
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
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
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
    proxy.send(JSON.stringify(proxyRegister()));
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
    const selected = JSON.parse(await waitForMessage(client1));
    expect(selected.bindingId).toEqual(expect.any(String));

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
    expect(response.bindingId).toEqual(expect.any(String));
    expect(response.bindingId).not.toBe(selected.bindingId);
  });

  it("returns restored without relay-side message replay", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister()));
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
      payload: {
        turnId: `turn-${seq}`,
        revision: 1,
        text: `msg-${seq}`,
        status: "completed",
      },
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
    proxy.send(JSON.stringify(proxyRegister()));
    await settle();

    const previousClient = connectClient();
    await waitForOpen(previousClient);
    previousClient.send(JSON.stringify(clientRegister("c1")));
    await waitForMessageType(previousClient, "client_register_response");
    previousClient.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    const previousSelection = JSON.parse(
      await waitForMessageType(previousClient, "proxy_select_response"),
    );

    const replacementClient = connectClient();
    await waitForOpen(replacementClient);
    replacementClient.send(JSON.stringify(clientRegister("c1")));
    const restored = JSON.parse(
      await waitForMessageType(replacementClient, "client_register_response"),
    );
    expect(restored).toMatchObject({
      status: "restored",
      proxyId: "p1",
      bindingId: expect.any(String),
    });
    expect(restored.bindingId).not.toBe(previousSelection.bindingId);

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
        payload: {
          turnId: "turn-connected",
          revision: 1,
          text: "still connected",
          status: "completed",
        },
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
    proxy.send(JSON.stringify(proxyRegister()));
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
    expect(response.bindingId).toEqual(expect.any(String));
  });

  it("sends PROXY_OFFLINE error when client sends envelope during grace period", async () => {
    // 注册 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister()));
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
    proxy.send(JSON.stringify(proxyRegister()));
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
    proxy1.send(JSON.stringify(proxyRegister()));
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
    proxy2.send(JSON.stringify(proxyRegister()));

    const onlineMsg = JSON.parse(await onlinePromise);
    expect(onlineMsg.type).toBe("proxy_online");
    expect(onlineMsg.proxyId).toBe("p1");
  });

  it("proxy_select returns proxy_select_response with success true", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister()));
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
    expect(response.bindingId).toEqual(expect.any(String));
  });

  it("proxy_list_response includes sessions per proxy", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister()));
    await waitForMessage(proxy); // consume register response
    await settle();

    // proxy 发送 session_sync 注册 session
    proxy.send(
      JSON.stringify({
        type: "session_sync",
        sessions: [
          {
            id: "s1",
            kind: "agent",
            mode: "pty",
            provider: "claude",
            ptyOwner: "proxy-hosted",
            cwd: "/tmp/project",
            state: "idle",
          },
          {
            id: "s2",
            kind: "agent",
            mode: "json",
            provider: "claude",
            cwd: "/tmp/project",
            state: "working",
          },
        ],
      }),
    );
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify(clientRegister("session-list-client")));
    await waitForMessage(client);

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
    proxy.send(JSON.stringify(proxyRegister()));
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
    proxy.send(JSON.stringify(proxyRegister()));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.protocolVersion).toBe(RELAY_CONTROL_PROTOCOL_VERSION);
    expect(response.status).toBe("new");
    expect(response.relayVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(response.connectionId).toEqual(expect.any(String));
  });

  it("proxy receives proxy_register_response with status 'reconnected' on second register with same proxyId", async () => {
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify(proxyRegister()));
    const firstResponse = JSON.parse(await waitForMessage(proxy1));
    await settle();

    // proxy 断线
    proxy1.close();
    await settle(100);

    // proxy 重连
    const proxy2 = connectProxy();
    await waitForOpen(proxy2);

    const msgPromise = waitForMessage(proxy2);
    proxy2.send(JSON.stringify(proxyRegister()));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.protocolVersion).toBe(RELAY_CONTROL_PROTOCOL_VERSION);
    expect(response.status).toBe("reconnected");
    expect(response.connectionId).toEqual(expect.any(String));
    expect(response.connectionId).not.toBe(firstResponse.connectionId);
  });
});
