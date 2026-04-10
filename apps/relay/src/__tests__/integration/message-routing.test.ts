import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import pino from "pino";
import { waitForOpen, waitForMessage, collectMessages, getPort, settle } from "../helpers.js";

const logger = pino({ level: "silent" });

/**
 * Phase 6 Plan 05.1 集成测试
 *
 * 验证两层消息协议：Envelope (有 seq, 进 buffer, 可重放) 和 Control (无 seq, 不进 buffer)
 * 使用真实 relay server 和 WebSocket 连接，不 mock 任何组件
 */
describe("Phase 6 Integration: Message Routing", () => {
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

  // 注册 proxy + client 并绑定
  // 匹配 server.test.ts 的模式：proxy_register + proxy_select + settle
  async function setupBoundPair(): Promise<{ proxy: WebSocket; client: WebSocket }> {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1", name: "test-machine" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    return { proxy, client };
  }

  // ==========================================================
  // 1. Envelope 端到端（proxy -> relay -> client）
  // ==========================================================

  it("routes assistant_message envelope from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(), source: "proxy", version: "1.0",
      type: "assistant_message",
      payload: { text: "hello", isPartial: false },
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("assistant_message");
    expect(received.payload.text).toBe("hello");
  });

  it("routes tool_approve with whitelistTool from client to proxy", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(proxy);
    client.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(), source: "client", version: "1.0",
      type: "tool_approve",
      payload: { toolId: "t1", whitelistTool: true },
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("tool_approve");
    expect(received.payload.toolId).toBe("t1");
    expect(received.payload.whitelistTool).toBe(true);
  });

  // ==========================================================
  // 2. Control 消息端到端（proxy -> relay -> client）
  // ==========================================================

  it("routes terminal_frame control message from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "terminal_frame",
      sessionId: "s1",
      payload: { mode: "full", lines: [[{ text: "$ hello", fg: "#00ff00" }]] },
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("terminal_frame");
    expect(received.payload.lines[0][0].text).toBe("$ hello");
  });

  it("routes pty_state control message from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "pty_state",
      sessionId: "s1",
      payload: { state: "approval_wait", tool: "Bash" },
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("pty_state");
    expect(received.payload.state).toBe("approval_wait");
    expect(received.payload.tool).toBe("Bash");
  });

  it("routes command_list_push from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "command_list_push",
      commands: [{ name: "/compact", description: "Compact", source: "builtin" }],
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("command_list_push");
    expect(received.commands[0].name).toBe("/compact");
  });

  it("routes file_tree_push from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "file_tree_push",
      path: "/src",
      entries: [{ name: "index.ts", isDir: false }],
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("file_tree_push");
    expect(received.entries[0].name).toBe("index.ts");
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
    proxy.send(JSON.stringify({
      type: "dir_list_response",
      path: "/home",
      entries: [{ name: "src", isDir: true }],
    }));

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
    proxy.send(JSON.stringify({
      type: "session_history_response",
      sessions: [{ id: "s1", title: "test", projectDir: "/proj", updatedAt: 123 }],
    }));

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("session_history_response");
    expect(clientReceived.sessions[0].id).toBe("s1");
  });

  it("routes terminal_lines_request/response full round trip", async () => {
    const { proxy, client } = await setupBoundPair();

    const proxyMsgPromise = waitForMessage(proxy);
    client.send(JSON.stringify({
      type: "terminal_lines_request",
      sessionId: "s1",
      fromLineId: 100,
      count: 50,
    }));

    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("terminal_lines_request");
    expect(proxyReceived.fromLineId).toBe(100);
    expect(proxyReceived.count).toBe(50);

    const clientMsgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "terminal_lines_response",
      sessionId: "s1",
      fromLineId: 100,
      oldestLineId: 50,
      newestLineId: 200,
      lines: [[{ text: "output line" }]],
    }));

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("terminal_lines_response");
    expect(clientReceived.fromLineId).toBe(100);
    expect(clientReceived.oldestLineId).toBe(50);
    expect(clientReceived.lines[0][0].text).toBe("output line");
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
    expect(response.proxies).toEqual([{ proxyId: "p1", name: "My MacBook" }]);
  });

  // ==========================================================
  // 5. Buffer 行为验证
  // ==========================================================

  it("terminal_frame does not enter session buffer", async () => {
    const { proxy, client } = await setupBoundPair();

    // 发送 Envelope 消息使 buffer 增长
    proxy.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(), source: "proxy", version: "1.0",
      type: "assistant_message",
      payload: { text: "msg-1", isPartial: false },
    }));
    await settle();

    const bufferBefore = relay.registry.getSessionBuffer("s1");
    expect(bufferBefore).toBeDefined();
    const sizeBefore = bufferBefore!.size();
    expect(sizeBefore).toBe(1);

    // 发送 terminal_frame（Control 消息，不应进 buffer）
    const clientMsgPromise = waitForMessage(client);
    proxy.send(JSON.stringify({
      type: "terminal_frame",
      sessionId: "s1",
      payload: { mode: "full", lines: [[{ text: "frame" }]] },
    }));
    await clientMsgPromise;
    await settle();

    expect(relay.registry.getSessionBuffer("s1")!.size()).toBe(sizeBefore);
  });

  it("assistant_message enters session buffer", async () => {
    const { proxy } = await setupBoundPair();

    proxy.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(), source: "proxy", version: "1.0",
      type: "assistant_message",
      payload: { text: "msg-1", isPartial: false },
    }));
    await settle();

    const buffer = relay.registry.getSessionBuffer("s1");
    expect(buffer).toBeDefined();
    expect(buffer!.size()).toBe(1);

    proxy.send(JSON.stringify({
      seq: 2, sessionId: "s1", timestamp: Date.now(), source: "proxy", version: "1.0",
      type: "assistant_message",
      payload: { text: "msg-2", isPartial: false },
    }));
    await settle();

    expect(buffer!.size()).toBe(2);
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
    client.send(JSON.stringify({
      seq: 1, sessionId: "s1", timestamp: Date.now(), source: "client", version: "1.0",
      type: "user_input",
      payload: { text: "hello" },
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("relay_error");
    expect(received.code).toBe("NOT_BOUND");
  });

  it("unbound client sending terminal_lines_request receives relay_error", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await waitForMessage(proxy);

    const client = connectClient();
    await waitForOpen(client);
    // 不 bind，直接发 terminal_lines_request
    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({
      type: "terminal_lines_request",
      sessionId: "s1",
      fromLineId: 0,
      count: 10,
    }));

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("relay_error");
    expect(received.code).toBe("NOT_BOUND");
  });

  // ==========================================================
  // 多消息连续路由
  // ==========================================================

  it("routes interleaved terminal_frame and pty_state in sequence", async () => {
    const { proxy, client } = await setupBoundPair();

    const messagesPromise = collectMessages(client, 3);

    proxy.send(JSON.stringify({
      type: "terminal_frame", sessionId: "s1",
      payload: { mode: "full", lines: [[{ text: "$ npm test" }]] },
    }));
    proxy.send(JSON.stringify({
      type: "pty_state", sessionId: "s1",
      payload: { state: "working", title: "Running tests" },
    }));
    proxy.send(JSON.stringify({
      type: "terminal_frame", sessionId: "s1",
      payload: { mode: "full", lines: [[{ text: "$ npm test" }], [{ text: "PASS", fg: "#00ff00" }]] },
    }));

    const received = (await messagesPromise).map((m) => JSON.parse(m));
    expect(received).toHaveLength(3);
    expect(received[0].type).toBe("terminal_frame");
    expect(received[1].type).toBe("pty_state");
    expect(received[2].type).toBe("terminal_frame");
    expect(received[2].payload.lines).toHaveLength(2);
  });
});
