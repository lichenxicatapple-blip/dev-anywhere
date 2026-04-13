import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRelayServer, type RelayServer } from "#src/server.js";
import { WebSocket } from "ws";
import { createLogger } from "@cc-anywhere/shared";
import { waitForOpen, waitForMessage, collectMessages, getPort, settle, makeEnvelope } from "../helpers.js";

const logger = createLogger({ name: "test", silent: true });

describe("replay_request protocol", () => {
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

  it("replays messages in requested seq range", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // Proxy 发送 5 条消息填充 buffer
    const clientMsgs = collectMessages(client, 5);
    for (let i = 1; i <= 5; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i)));
    }
    await clientMsgs;

    // 请求 seq 2-4 的回放
    const replayMsgs = collectMessages(client, 3);
    client.send(JSON.stringify({
      type: "replay_request",
      sessionId: "s1",
      fromSeq: 2,
      toSeq: 4,
    }));

    const received = await replayMsgs;
    expect(received.length).toBe(3);

    const msg1 = JSON.parse(received[0]);
    expect(msg1.seq).toBe(2);
    const msg2 = JSON.parse(received[1]);
    expect(msg2.seq).toBe(3);
    const msg3 = JSON.parse(received[2]);
    expect(msg3.seq).toBe(4);
  });

  it("sends gap_unrecoverable for partially available range", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // 只发送 seq 3-5，缓冲区没有 seq 1-2
    const clientMsgs = collectMessages(client, 3);
    for (let i = 3; i <= 5; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i)));
    }
    await clientMsgs;

    // 请求 seq 1-5，缓冲区只有 3-5
    // 应该收到 seq 3-5 的消息 + gap_unrecoverable(1-2)
    const replayMsgs = collectMessages(client, 4);
    client.send(JSON.stringify({
      type: "replay_request",
      sessionId: "s1",
      fromSeq: 1,
      toSeq: 5,
    }));

    const received = await replayMsgs;
    expect(received.length).toBe(4);

    // 前 3 条是消息 seq 3, 4, 5
    const msg1 = JSON.parse(received[0]);
    expect(msg1.seq).toBe(3);
    const msg2 = JSON.parse(received[1]);
    expect(msg2.seq).toBe(4);
    const msg3 = JSON.parse(received[2]);
    expect(msg3.seq).toBe(5);

    // 最后一条是 gap_unrecoverable
    const gap = JSON.parse(received[3]);
    expect(gap.type).toBe("gap_unrecoverable");
    expect(gap.sessionId).toBe("s1");
    expect(gap.fromSeq).toBe(1);
    expect(gap.toSeq).toBe(2);
  });

  it("sends gap_unrecoverable when no messages in requested range", async () => {
    const proxy = connectProxy();
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p1" }));
    await settle();

    const client = connectClient();
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "p1" }));
    await settle();

    // 发送 seq 10-12 填充 buffer
    const clientMsgs = collectMessages(client, 3);
    for (let i = 10; i <= 12; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i)));
    }
    await clientMsgs;

    // 请求 seq 1-5 完全不在 buffer 中
    const replayMsg = waitForMessage(client);
    client.send(JSON.stringify({
      type: "replay_request",
      sessionId: "s1",
      fromSeq: 1,
      toSeq: 5,
    }));

    const response = JSON.parse(await replayMsg);
    expect(response.type).toBe("gap_unrecoverable");
    expect(response.sessionId).toBe("s1");
    expect(response.fromSeq).toBe(1);
    expect(response.toSeq).toBe(5);
  });

  it("sends gap_unrecoverable for unknown sessionId", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({
      type: "replay_request",
      sessionId: "nonexistent-session",
      fromSeq: 1,
      toSeq: 10,
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("gap_unrecoverable");
    expect(response.sessionId).toBe("nonexistent-session");
    expect(response.fromSeq).toBe(1);
    expect(response.toSeq).toBe(10);
  });

  it("sends relay_error INVALID_RANGE when fromSeq > toSeq", async () => {
    const client = connectClient();
    await waitForOpen(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({
      type: "replay_request",
      sessionId: "s1",
      fromSeq: 10,
      toSeq: 5,
    }));

    const response = JSON.parse(await msgPromise);
    expect(response.type).toBe("relay_error");
    expect(response.code).toBe("INVALID_RANGE");
  });
});
