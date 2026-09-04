import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_JSON_MESSAGE_MAX_BYTES,
  serializeControl,
} from "@dev-anywhere/shared";
import { collectMessages, waitForOpen, waitForMessage, getPort, settle } from "../helpers.js";

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

  function proxyRegister(proxyId: string, name?: string): Record<string, unknown> {
    return {
      type: "proxy_register",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      proxyId,
      ...(name ? { name } : {}),
      proxyVersion: "0.9.0",
    };
  }

  async function registerClient(client: WebSocket, clientId: string): Promise<void> {
    client.send(
      JSON.stringify({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
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
    proxy.send(JSON.stringify(proxyRegister("p1", "test-machine")));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    await registerClient(client, "client-routing");
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(client); // consume proxy_select_response ACK

    return { proxy, client };
  }

  async function setupTwoClientsBoundToOneProxy(): Promise<{
    proxy: WebSocket;
    clientA: WebSocket;
    clientB: WebSocket;
  }> {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister("p1", "test-machine")));
    await settle();

    const clientA = connectClient();
    await waitForOpen(clientA);
    await registerClient(clientA, "client-snapshot-a");
    clientA.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(clientA);

    const clientB = connectClient();
    await waitForOpen(clientB);
    await registerClient(clientB, "client-snapshot-b");
    clientB.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await waitForMessage(clientB);

    return { proxy, clientA, clientB };
  }

  function recordSnapshotRequestIds(client: WebSocket): string[] {
    const requestIds: string[] = [];
    client.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; requestId?: string };
        if (message.type === "session_snapshot" && typeof message.requestId === "string") {
          requestIds.push(message.requestId);
        }
      } catch {
        // PTY binary frames and unrelated messages are outside this control-routing contract.
      }
    });
    return requestIds;
  }

  function transportBytes(ws: WebSocket, field: "bytesRead" | "bytesWritten"): number {
    return (ws as unknown as { _socket: { bytesRead: number; bytesWritten: number } })._socket[
      field
    ];
  }

  // ==========================================================
  // 1. Envelope 端到端（proxy -> relay -> client）
  // ==========================================================

  it("negotiates deflate for proxy and data-client sockets but not voice", async () => {
    const proxy = connectProxy();
    const client = connectClient();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice/asr`);
    connections.push(voice);

    await Promise.all([waitForOpen(proxy), waitForOpen(client), waitForOpen(voice)]);

    expect(proxy.extensions).toContain("permessage-deflate");
    expect(client.extensions).toContain("permessage-deflate");
    expect(voice.extensions).toBe("");
  });

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
        payload: { turnId: "turn-1", revision: 1, text: "hello", status: "completed" },
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
    await registerClient(client, "latency-client");

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

  // 目录请求只使用当前绑定的 Proxy，额外指定目标属于非法请求。
  it("rejects a forged dir_list_request proxyId without routing", async () => {
    const proxy1 = connectProxy();
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify(proxyRegister("p1", "m1")));
    await settle();

    const proxy2 = connectProxy();
    await waitForOpen(proxy2);
    proxy2.send(JSON.stringify(proxyRegister("p2", "m2")));
    await settle();

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

    const errorPromise = waitForMessage(client);
    client.send(
      JSON.stringify({
        type: "dir_list_request",
        requestId: "r1",
        path: "/etc",
        proxyId: "p2",
        includeHidden: false,
      }),
    );

    const error = JSON.parse(await errorPromise);
    await settle();
    expect(error).toMatchObject({ type: "relay_error", code: "INVALID_MESSAGE" });
    expect(p1ReceivedDirList).toBe(false);
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
        payload: { state: "approval_wait", seq: 1, tool: "Bash" },
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("pty_state");
    expect(received.payload.state).toBe("approval_wait");
    expect(received.payload.tool).toBe("Bash");
  });

  it("routes PTY snapshots larger than 1 MiB from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const oneMiB = 1024 * 1024;
    const snapshotData = "x".repeat(oneMiB + 128);
    const raw = serializeControl({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: "snapshot-large",
      cols: 270,
      rows: 57,
      data: snapshotData,
      outputSeq: 1,
    });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(oneMiB);
    expect(Buffer.byteLength(raw)).toBeLessThan(RELAY_JSON_MESSAGE_MAX_BYTES);

    const subscribePromise = waitForMessage(proxy);
    client.send(
      JSON.stringify({
        type: "session_subscribe",
        sessionId: "s1",
        requestId: "snapshot-large",
      }),
    );
    await subscribePromise;

    const msgPromise = waitForMessage(client);
    const proxyBytesBefore = transportBytes(proxy, "bytesWritten");
    const clientBytesBefore = transportBytes(client, "bytesRead");
    proxy.send(raw);

    const received = JSON.parse(await msgPromise);
    expect(received).toMatchObject({
      type: "session_snapshot",
      sessionId: "s1",
      requestId: "snapshot-large",
      cols: 270,
      rows: 57,
      outputSeq: 1,
    });
    expect(received.data).toHaveLength(snapshotData.length);
    const proxyWireBytes = transportBytes(proxy, "bytesWritten") - proxyBytesBefore;
    const clientWireBytes = transportBytes(client, "bytesRead") - clientBytesBefore;
    expect(proxyWireBytes).toBeLessThan(Buffer.byteLength(raw) / 4);
    expect(clientWireBytes).toBeLessThan(Buffer.byteLength(raw) / 4);
  });

  it("routes concurrent PTY snapshots only to their requesting clients even in reverse order", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const proxyRequestsPromise = collectMessages(proxy, 2, 1_000);

    clientA.send(
      JSON.stringify({ type: "session_subscribe", sessionId: "s1", requestId: "snapshot-a" }),
    );
    clientB.send(
      JSON.stringify({ type: "session_subscribe", sessionId: "s1", requestId: "snapshot-b" }),
    );

    const proxyRequests = (await proxyRequestsPromise).map((raw) => JSON.parse(raw));
    expect(proxyRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_subscribe",
          sessionId: "s1",
          requestId: "snapshot-a",
        }),
        expect.objectContaining({
          type: "session_subscribe",
          sessionId: "s1",
          requestId: "snapshot-b",
        }),
      ]),
    );

    const snapshotsAtA = recordSnapshotRequestIds(clientA);
    const snapshotsAtB = recordSnapshotRequestIds(clientB);
    const largeSnapshot = "x".repeat(1024 * 1024 + 128);

    // The proxy is allowed to finish requests out of order. requestId, not response order or the
    // shared proxy binding, identifies the exact browser socket that paid for this large payload.
    proxy.send(
      serializeControl({
        type: "session_snapshot",
        sessionId: "s1",
        requestId: "snapshot-b",
        cols: 270,
        rows: 57,
        data: "snapshot-for-b",
        outputSeq: 20,
      }),
    );
    proxy.send(
      serializeControl({
        type: "session_snapshot",
        sessionId: "s1",
        requestId: "snapshot-a",
        cols: 270,
        rows: 57,
        data: largeSnapshot,
        outputSeq: 21,
      }),
    );
    await settle(150);

    expect(snapshotsAtA).toEqual(["snapshot-a"]);
    expect(snapshotsAtB).toEqual(["snapshot-b"]);
  });

  it("deduplicates a same-socket retry with the same PTY snapshot requestId", async () => {
    const { proxy, client } = await setupBoundPair();
    const proxySubscribes: Array<{ type?: string; requestId?: string }> = [];
    proxy.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; requestId?: string };
        if (message.type === "session_subscribe") proxySubscribes.push(message);
      } catch {
        // Ignore unrelated binary data.
      }
    });
    const subscribe = JSON.stringify({
      type: "session_subscribe",
      sessionId: "s1",
      requestId: "snapshot-retry",
    });

    client.send(subscribe);
    client.send(subscribe);
    await settle(150);

    expect(proxySubscribes).toEqual([
      expect.objectContaining({ requestId: "snapshot-retry", type: "session_subscribe" }),
    ]);
  });

  it("forwards the same snapshot requestId again after its proxy reconnects", async () => {
    const { proxy: oldProxy, client } = await setupBoundPair();
    const subscribe = JSON.stringify({
      type: "session_subscribe",
      sessionId: "s1",
      requestId: "snapshot-across-reconnect",
    });

    const oldProxyRequest = waitForMessage(oldProxy);
    client.send(subscribe);
    expect(JSON.parse(await oldProxyRequest)).toMatchObject({
      type: "session_subscribe",
      requestId: "snapshot-across-reconnect",
    });

    const newProxy = connectProxy();
    await waitForOpen(newProxy);
    const registerResponse = waitForMessage(newProxy);
    newProxy.send(JSON.stringify(proxyRegister("p1")));
    await registerResponse;

    const newProxyRequest = waitForMessage(newProxy);
    client.send(subscribe);
    expect(JSON.parse(await newProxyRequest)).toMatchObject({
      type: "session_subscribe",
      requestId: "snapshot-across-reconnect",
    });

    const received = recordSnapshotRequestIds(client);
    newProxy.send(
      serializeControl({
        type: "session_snapshot",
        sessionId: "s1",
        requestId: "snapshot-across-reconnect",
        cols: 80,
        rows: 24,
        data: "new-proxy-snapshot",
        outputSeq: 1,
      }),
    );
    await settle(150);
    expect(received).toEqual(["snapshot-across-reconnect"]);
  });

  it("drops a matched PTY snapshot after its requesting client disconnects", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const proxyRequestPromise = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({
        type: "session_subscribe",
        sessionId: "s1",
        requestId: "snapshot-abandoned",
      }),
    );
    expect(JSON.parse(await proxyRequestPromise)).toMatchObject({
      type: "session_subscribe",
      requestId: "snapshot-abandoned",
    });

    const snapshotsAtB = recordSnapshotRequestIds(clientB);
    await new Promise<void>((resolve) => {
      clientA.once("close", () => resolve());
      clientA.close();
    });

    proxy.send(
      serializeControl({
        type: "session_snapshot",
        sessionId: "s1",
        requestId: "snapshot-abandoned",
        cols: 80,
        rows: 24,
        data: "must-not-fall-back-to-broadcast",
        outputSeq: 1,
      }),
    );
    await settle(150);

    expect(snapshotsAtB).toEqual([]);
  });

  it("rejects PTY subscribe and snapshot messages without requestId", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const proxySubscribes: string[] = [];
    proxy.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "session_subscribe") proxySubscribes.push(data.toString());
      } catch {
        // Ignore unrelated binary frames.
      }
    });
    const snapshotsAtB = recordSnapshotRequestIds(clientB);

    const clientError = waitForMessage(clientA);
    clientA.send(JSON.stringify({ type: "session_subscribe", sessionId: "s1" }));
    expect(JSON.parse(await clientError)).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });

    const proxyError = waitForMessage(proxy);
    proxy.send(
      JSON.stringify({
        type: "session_snapshot",
        sessionId: "s1",
        cols: 80,
        rows: 24,
        data: "must-be-rejected",
        outputSeq: 1,
      }),
    );
    expect(JSON.parse(await proxyError)).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });
    await settle(150);

    expect(proxySubscribes).toEqual([]);
    expect(snapshotsAtB).toEqual([]);
  });

  it("routes command_list_push from proxy to client", async () => {
    const { proxy, client } = await setupBoundPair();

    const msgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "command_list_push",
        sessionId: "session-1",
        commands: [{ name: "/compact", description: "Compact", source: "builtin" }],
      }),
    );

    const received = JSON.parse(await msgPromise);
    expect(received.type).toBe("command_list_push");
    expect(received.sessionId).toBe("session-1");
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
    const requestId = "dir-list-round-trip";

    const proxyMsgPromise = waitForMessage(proxy);
    client.send(
      JSON.stringify({
        type: "dir_list_request",
        requestId,
        path: "/home",
        includeHidden: true,
      }),
    );

    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("dir_list_request");
    expect(proxyReceived.requestId).toBe(requestId);
    expect(proxyReceived.includeHidden).toBe(true);

    const clientMsgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "dir_list_response",
        requestId,
        path: "/home",
        entries: [{ name: "src", isDir: true }],
        includeHidden: true,
      }),
    );

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("dir_list_response");
    expect(clientReceived.requestId).toBe(requestId);
    expect(clientReceived.includeHidden).toBe(true);
    expect(clientReceived.entries[0].name).toBe("src");
  });

  it("routes session_history_request/response full round trip", async () => {
    const { proxy, client } = await setupBoundPair();
    const requestId = "history-round-trip";

    const proxyMsgPromise = waitForMessage(proxy);
    client.send(JSON.stringify({ type: "session_history_request", requestId }));

    const proxyReceived = JSON.parse(await proxyMsgPromise);
    expect(proxyReceived.type).toBe("session_history_request");
    expect(proxyReceived.requestId).not.toBe(requestId);
    expect(proxyReceived.requestId).toMatch(/^relay-history-/);

    const clientMsgPromise = waitForMessage(client);
    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        requestId: proxyReceived.requestId,
        success: true,
        sessions: [
          { id: "s1", title: "test", projectDir: "/proj", updatedAt: 123, provider: "claude" },
        ],
      }),
    );

    const clientReceived = JSON.parse(await clientMsgPromise);
    expect(clientReceived.type).toBe("session_history_response");
    expect(clientReceived.requestId).toBe(requestId);
    expect(clientReceived.sessions[0].id).toBe("s1");
  });

  it("fans concurrent session history requests into one upstream response and preserves client IDs", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const receivedByA: Array<{ type?: string; requestId?: string; sessions?: unknown[] }> = [];
    const receivedByB: Array<{ type?: string; requestId?: string; sessions?: unknown[] }> = [];
    const proxyRequests: Array<{ type?: string; requestId?: string }> = [];
    clientA.on("message", (data) => receivedByA.push(JSON.parse(data.toString())));
    clientB.on("message", (data) => receivedByB.push(JSON.parse(data.toString())));
    proxy.on("message", (data) => proxyRequests.push(JSON.parse(data.toString())));

    clientA.send(
      JSON.stringify({ type: "session_history_request", requestId: "history-client-a" }),
    );
    clientB.send(
      JSON.stringify({ type: "session_history_request", requestId: "history-client-b" }),
    );

    await settle(100);
    expect(proxyRequests).toHaveLength(1);
    const upstreamRequestId = proxyRequests[0]?.requestId;
    expect(proxyRequests[0]?.type).toBe("session_history_request");
    expect(upstreamRequestId).toMatch(/^relay-history-/);

    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        requestId: upstreamRequestId,
        success: true,
        sessions: [
          {
            id: "shared",
            title: "Shared",
            projectDir: "/shared",
            updatedAt: 2,
            provider: "claude",
          },
        ],
      }),
    );
    await settle(100);

    expect(receivedByA).toEqual([
      expect.objectContaining({
        type: "session_history_response",
        requestId: "history-client-a",
        sessions: [expect.objectContaining({ id: "shared" })],
      }),
    ]);
    expect(receivedByB).toEqual([
      expect.objectContaining({
        type: "session_history_response",
        requestId: "history-client-b",
        sessions: [expect.objectContaining({ id: "shared" })],
      }),
    ]);
  });

  it("fans an upstream history failure out with each requesting client ID", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const proxyRequest = waitForMessage(proxy);
    const responseA = waitForMessage(clientA);
    const responseB = waitForMessage(clientB);

    clientA.send(JSON.stringify({ type: "session_history_request", requestId: "failure-a" }));
    clientB.send(JSON.stringify({ type: "session_history_request", requestId: "failure-b" }));
    const upstream = JSON.parse(await proxyRequest);
    await settle(100);

    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        requestId: upstream.requestId,
        success: false,
        sessions: [],
        errorCode: "UNKNOWN",
        error: "synthetic scan failure",
      }),
    );

    expect(JSON.parse(await responseA)).toMatchObject({
      type: "session_history_response",
      requestId: "failure-a",
      success: false,
      sessions: [],
      error: "synthetic scan failure",
    });
    expect(JSON.parse(await responseB)).toMatchObject({
      type: "session_history_response",
      requestId: "failure-b",
      success: false,
      sessions: [],
      error: "synthetic scan failure",
    });
  });

  it("drops an unmatched request-scoped history response instead of broadcasting it", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    clientA.on("message", (data) => receivedByA.push(JSON.parse(data.toString())));
    clientB.on("message", (data) => receivedByB.push(JSON.parse(data.toString())));

    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        requestId: "history-unmatched",
        success: true,
        sessions: [],
      }),
    );
    await settle(100);

    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([]);
  });

  it("keeps a joined history waiter alive after the upstream leader client disconnects", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const proxyRequest = waitForMessage(proxy);
    clientA.send(
      JSON.stringify({ type: "session_history_request", requestId: "history-abandoned" }),
    );
    clientB.send(JSON.stringify({ type: "session_history_request", requestId: "history-live" }));
    const upstream = JSON.parse(await proxyRequest);
    expect(upstream.type).toBe("session_history_request");
    expect(upstream.requestId).toMatch(/^relay-history-/);
    await settle(100);

    const responseB = waitForMessage(clientB);
    await new Promise<void>((resolve) => {
      clientA.once("close", () => resolve());
      clientA.close();
    });
    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        requestId: upstream.requestId,
        success: true,
        sessions: [
          {
            id: "survived",
            title: "Survived",
            projectDir: "/ok",
            updatedAt: 1,
            provider: "claude",
          },
        ],
      }),
    );

    expect(JSON.parse(await responseB)).toMatchObject({
      type: "session_history_response",
      requestId: "history-live",
      sessions: [{ id: "survived" }],
    });
  });

  it("rejects a session history request without requestId before it reaches the proxy", async () => {
    const { proxy, client } = await setupBoundPair();
    const receivedByProxy: unknown[] = [];
    proxy.on("message", (data) => receivedByProxy.push(JSON.parse(data.toString())));
    const relayError = waitForMessage(client);

    client.send(JSON.stringify({ type: "session_history_request" }));

    expect(JSON.parse(await relayError)).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });
    await settle(100);
    expect(receivedByProxy).toEqual([]);
  });

  it("rejects a session history response without requestId instead of broadcasting it", async () => {
    const { proxy, clientA, clientB } = await setupTwoClientsBoundToOneProxy();
    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    clientA.on("message", (data) => receivedByA.push(JSON.parse(data.toString())));
    clientB.on("message", (data) => receivedByB.push(JSON.parse(data.toString())));
    const relayError = waitForMessage(proxy);

    proxy.send(
      JSON.stringify({
        type: "session_history_response",
        success: true,
        sessions: [],
      }),
    );

    expect(JSON.parse(await relayError)).toMatchObject({
      type: "relay_error",
      code: "INVALID_MESSAGE",
    });
    await settle(100);
    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([]);
  });

  // ==========================================================
  // 4. proxy_list_response 包含 name
  // ==========================================================

  it("proxy_list_response includes proxy name", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify(proxyRegister("p1", "My MacBook")));
    await waitForMessage(proxy);

    const client = connectClient();
    await waitForOpen(client);
    await registerClient(client, "proxy-name-client");

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("proxy_list_response");
    expect(response.proxies).toEqual([
      {
        proxyId: "p1",
        name: "My MacBook",
        version: "0.9.0",
        online: true,
        sessions: [],
      },
    ]);
  });

  // ==========================================================
  // 5. Binary frame passthrough
  // ==========================================================

  it("keeps binary PTY frames uncompressed on the negotiated data channel", async () => {
    const { proxy, client } = await setupBoundPair();
    const sessionId = "s1";
    const body = Buffer.alloc(64 * 1024, 0x78);
    const frame = Buffer.concat([Buffer.from([sessionId.length]), Buffer.from(sessionId), body]);
    const proxyBytesBefore = transportBytes(proxy, "bytesWritten");
    const clientBytesBefore = transportBytes(client, "bytesRead");
    const received = new Promise<Buffer>((resolve) => {
      client.once("message", (data: Buffer, isBinary: boolean) => {
        expect(isBinary).toBe(true);
        resolve(data);
      });
    });

    proxy.send(frame, { binary: true, compress: false });
    expect(await received).toEqual(frame);

    const proxyToRelay = transportBytes(proxy, "bytesWritten") - proxyBytesBefore;
    const relayToClient = transportBytes(client, "bytesRead") - clientBytesBefore;
    // A compressed 64 KiB run of repeated bytes would be only a few hundred bytes. Both legs
    // staying near the application size proves the explicitly-uncompressed Proxy ingress and
    // Relay egress remain raw despite permessage-deflate being negotiated for large JSON.
    expect(proxyToRelay).toBeGreaterThanOrEqual(frame.length);
    expect(proxyToRelay).toBeLessThan(frame.length + 256);
    expect(relayToClient).toBeGreaterThanOrEqual(frame.length);
    expect(relayToClient).toBeLessThan(frame.length + 256);
  });

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
    proxy.send(JSON.stringify(proxyRegister("p1")));
    await waitForMessage(proxy);

    const client = connectClient();
    await waitForOpen(client);
    await registerClient(client, "unbound-client");
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
        payload: { state: "working", seq: 1, title: "Running tests" },
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
