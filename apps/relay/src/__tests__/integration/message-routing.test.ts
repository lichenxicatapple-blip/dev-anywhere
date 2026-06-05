import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import { waitForOpen, waitForMessage, getPort, settle } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

/**
 * 验证两层消息协议：Envelope (有 seq, 进 buffer, 可重放) 和 Control (无 seq, 不进 buffer)
 * 使用真实 relay server 和 WebSocket 连接，不 mock 任何组件
 */
describe("Message routing integration", () => {
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
    await waitForMessage(client); // consume client_register_response
  }

  // 注册 proxy + client 并绑定
  // 匹配正式协议：proxy_register + client_register + proxy_select。
  async function setupBoundPair(): Promise<{ proxy: WebSocket; client: WebSocket }> {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1", name: "test-machine" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    await registerClient(client, "client-routing");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response ACK

    return { proxy, client };
  }

  // ==========================================================
  // 1. Envelope 端到端（proxy -> relay -> client）
  // ==========================================================

  it("routes assistant_message envelope from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        seq: 1,
        sessionId: "s1",
        timestamp: Date.now(),
        source: "proxy",
        version: "1.0",
        type: "assistant_message",
        payload: { text: "hello", isPartial: false },
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("assistant_message");
    expect(received.payload.text).toBe("hello");
  });

  it("routes tool_approve control with whitelistTool from client to proxy", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(proxy);
    client.send(
      JSON.stringify({
        sessionId: "s1",
        type: "tool_approve",
        payload: { toolId: "t1", whitelistTool: true },
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("tool_approve");
    expect(received.payload.toolId).toBe("t1");
    expect(received.payload.whitelistTool).toBe(true);
  });

  it("answers Web to Relay latency probes directly", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "latency_web_relay_ping", requestId: "latency-1" }));

    const received = JSON.parse(await msgPromise);
    expect(received).toMatchObject({
      type: "latency_web_relay_pong",
      requestId: "latency-1",
    });
    expect(typeof received.relayNow).toBe("number");
  });

  it("measures Relay to proxy latency through an internal ping/pong", async () => {
    const { proxy, client } = await setupBoundPair();

    const proxyPingPromise = waitForMessage(proxy);
    client.send(JSON.stringify({ type: "latency_relay_proxy_request", requestId: "latency-2" }));

    const proxyPing = JSON.parse(await proxyPingPromise);
    expect(proxyPing).toMatchObject({
      type: "latency_relay_proxy_ping",
      requestId: "latency-2",
    });

    const clientResponsePromise = waitForMessage(client);
    proxy.send(JSON.stringify({ type: "latency_relay_proxy_pong", requestId: "latency-2" }));

    const received = JSON.parse(await clientResponsePromise);
    expect(received).toMatchObject({
      type: "latency_relay_proxy_response",
      requestId: "latency-2",
      success: true,
    });
    expect(typeof received.rttMs).toBe("number");
  });

  // 跨租户隔离: 客户端 control msg 携带 proxyId 字段时, relay 必须忽略它, 只用 boundProxyId 路由。
  // dir_list_request 的 schema 显式带 proxyId (历史上设计为可指定 proxy), 是这个漏洞的载体——
  // 绑到 p1 的客户端通过 dir_list_request{proxyId:"p2"} 即可读取 p2 的本地目录。
  it("ignores client-supplied proxyId override; routes only to boundProxyId", async () => {
    // 起两个 proxy: p1 (client 绑这个) + p2 (client 不应能联到)
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "p1", name: "m1" }));
    await settle();

    const proxy2 = connectProxy();
    await waitForOpen(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "p2", name: "m2" }));
    await settle();

    // 同时订阅两个 proxy 看 dir_list_request 落到哪里
    let p1ReceivedDirList = false;
    let p2ReceivedDirList = false;
    proxy1.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "dir_list_request") p1ReceivedDirList = true;
    });
    proxy2.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "dir_list_request") p2ReceivedDirList = true;
    });

    const client = connectClient();
    await waitForOpen(client);
    await registerClient(client, "client-isolation");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response

    // 客户端尝试绕过: dir_list_request 字段里带 proxyId: "p2"
    client.send(
      JSON.stringify({
        type: "dir_list_request",
        requestId: "r1",
        path: "/etc",
        proxyId: "p2",
      }),
    );

    await settle();
    // 期望: 按 boundProxyId(=p1) 路由——p1 收到, p2 不收到
    expect(p1ReceivedDirList).toBe(true);
    expect(p2ReceivedDirList).toBe(false);
  });

  // ==========================================================
  // 2. Control 消息端到端（proxy -> relay -> client）
  // ==========================================================

  it("routes pty_state control message from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "pty_state",
        sessionId: "s1",
        payload: { state: "approval_wait", tool: "Bash" },
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("pty_state");
    expect(received.payload.state).toBe("approval_wait");
    expect(received.payload.tool).toBe("Bash");
  });

  it("routes command_list_push from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "command_list_push",
        commands: [{ name: "/compact", description: "Compact", source: "builtin" }],
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("command_list_push");
    expect(received.commands[0].name).toBe("/compact");
  });

  it("routes file_tree_push from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "file_tree_push",
        groups: [{ path: "/src", entries: [{ name: "index.ts", isDir: false }] }],
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("file_tree_push");
    expect(received.groups[0].entries[0].name).toBe("index.ts");
  });

  // ==========================================================
  // 3. Control 请求-响应（client -> relay -> proxy -> relay -> client）
  // ==========================================================

  it("routes dir_list_request/response full round trip", async () => {
    const { proxy, client } = await setupBoundPair();

    const proxyMsgPromise = waitForMessage(proxy);
    client.send(JSON.stringify({ type: "dir_list_request", proxyId: "p1", path: "/home" }));

    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("dir_list_request");

    const clientMsgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "dir_list_response",
        path: "/home",
        entries: [{ name: "src", isDir: true }],
      }),
    );

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("dir_list_response");
    expect(clientReceived.entries[0].name).toBe("src");
  });

  it("routes session_history_request/response full round trip", async () => {
    const { proxy, client } = await setupBoundPair();

    const proxyMsgPromise = waitForMessage(proxy);
    client.send(JSON.stringify({ type: "session_history_request" }));

    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("session_history_request");

    const clientMsgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        sessions: [{ id: "s1", title: "test", projectDir: "/proj", updatedAt: 123 }],
      }),
    );

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("session_history_response");
    expect(clientReceived.sessions[0].id).toBe("s1");
  });

  // ==========================================================
  // 4. proxy_list_response 包含 name
  // ==========================================================

  it("proxy_list_response includes proxy name", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1", name: "My MacBook" }));
    await waitForMessage(proxy);

    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_list_response");
    expect(response.proxies).toEqual([
      { proxyId: "p1", name: "My MacBook", online: true, sessions: [] },
    ]);
  });

  // ==========================================================
  // 5. Binary frame passthrough
  // ==========================================================

  it("routes binary frame from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    // 构造 binary 帧: [1B sessionIdLen][sessionId UTF-8][PTY data]
    const sessionId = "s1";
    const ptyData = Buffer.from("\x1b[32mhello\x1b[0m", "utf-8");
    const frame = Buffer.alloc(1 + sessionId.length + ptyData.length);
    frame[0] = sessionId.length;
    frame.write(sessionId, 1, "utf-8");
    ptyData.copy(frame, 1 + sessionId.length);

    const msgPromise = new Promise<Buffer>((resolve) => {
      client.once("message", (data: Buffer) => resolve(data));
    });

    proxy.send(frame);
    const received = await msgPromise;

    // client 收到完整 binary 帧（含 sessionId 前缀）
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.length).toBe(frame.length);
    const receivedSessionIdLen = received[0];
    expect(receivedSessionIdLen).toBe(sessionId.length);
    const receivedSessionId = received.subarray(1, 1 + receivedSessionIdLen).toString("utf-8");
    expect(receivedSessionId).toBe(sessionId);
    const receivedPtyData = received.subarray(1 + receivedSessionIdLen);
    expect(receivedPtyData.toString("utf-8")).toBe("\x1b[32mhello\x1b[0m");
  });

  it("binary frame from unregistered proxy is dropped", async () => {
    // 直接连接不注册的 proxy
    const proxy = connectProxy();
    await waitForOpen(proxy);

    const client = connectClient();
    await waitForOpen(client);

    // 发送 binary 帧（proxy 未注册）
    const frame = Buffer.from([2, 0x73, 0x31, 0x41]);
    proxy.send(frame);
    await settle();

    // client 不应收到任何消息（没有绑定关系）
  });

  // ==========================================================
  // 6. 错误边界
  // ==========================================================

  it("unbound client sending envelope receives relay_error", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy);

    const client = connectClient();
    await waitForOpen(client);
    // 不 bind，直接发 envelope
    const msgPromise = waitForMessage(client);
    client.send(
      JSON.stringify({
        seq: 1,
        sessionId: "s1",
        timestamp: Date.now(),
        source: "client",
        version: "1.0",
        type: "user_input",
        payload: { text: "hello" },
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("relay_error");
    expect(received.code).toBe("NOT_BOUND");
  });

  // ==========================================================
  // 多消息连续路由
  // ==========================================================

  it("routes interleaved JSON control and binary frames in sequence", async () => {
    const { proxy, client } = await setupBoundPair();

    // 先发一个 JSON control 消息
    const jsonMsgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "pty_state",
        sessionId: "s1",
        payload: { state: "working", title: "Running tests" },
      }),
    );
    const jsonReceived = JSON.parse(await jsonMsgPromise);
    expect(jsonReceived.type).toBe("pty_state");

    // 再发一个 binary 帧
    const sessionId = "s1";
    const ptyData = Buffer.from("PASS", "utf-8");
    const frame = Buffer.alloc(1 + sessionId.length + ptyData.length);
    frame[0] = sessionId.length;
    frame.write(sessionId, 1, "utf-8");
    ptyData.copy(frame, 1 + sessionId.length);

    const binaryMsgPromise = new Promise<Buffer>((resolve) => {
      client.once("message", (data: Buffer) => resolve(data));
    });
    proxy.send(frame);
    const binaryReceived = await binaryMsgPromise;
    expect(Buffer.isBuffer(binaryReceived)).toBe(true);
  });
});
