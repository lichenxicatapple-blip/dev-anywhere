import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@dev-anywhere/shared/logger";
import { createRelayServer, type RelayServer } from "@dev-anywhere/relay/server";
import { buildMessage, RELAY_CONTROL_PROTOCOL_VERSION } from "@dev-anywhere/shared";
import {
  RELAY_CONNECTION_WEBSOCKET_OPTIONS,
  RelayConnection,
  RelayConnectionState,
} from "#src/serve/relay-connection.js";

const relayLogger = createLogger({ name: "test", silent: true });

let relay: RelayServer;
let relayPort: number;

async function waitForProxyRegistration(conn: RelayConnection): Promise<void> {
  await vi.waitFor(() => expect(relay.registry.getProxy(conn.getProxyId())).toBeDefined());
}

beforeAll(async () => {
  relay = createRelayServer({ logger: relayLogger, heartbeatInterval: 60000 });
  await new Promise<void>((resolve) => {
    relay.httpServer.listen(0, () => {
      const addr = relay.httpServer.address();
      relayPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await relay.close();
});

describe("RelayConnection", () => {
  let conn: RelayConnection | null = null;

  afterEach(() => {
    conn?.close();
    conn = null;
  });

  it("uses bounded, context-free compression for large relay JSON messages", () => {
    expect(RELAY_CONNECTION_WEBSOCKET_OPTIONS).toEqual({
      maxPayload: 10 * 1024 * 1024,
      perMessageDeflate: {
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        threshold: 32 * 1024,
        concurrencyLimit: 4,
        zlibDeflateOptions: { level: 3, memLevel: 7 },
      },
    });
  });

  it("connects to relay and sends proxy_register with proxyId", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    conn.connect();

    await waitForProxyRegistration(conn);
    const proxyId = conn.getProxyId();
    expect(typeof proxyId).toBe("string");
    expect(proxyId.length).toBeGreaterThan(0);

    // 验证 proxy 已注册到 relay
    expect(relay.registry.getProxy(proxyId)).toBeDefined();
    expect(relay.registry.getProxy(proxyId)?.extensions).toContain("permessage-deflate");
  });

  it("exchanges Proxy and Relay versions during registration", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-version-test-"));
    const idPath = join(tmpDir, "proxy-id");
    const relayVersions: string[] = [];

    conn = new RelayConnection(`ws://localhost:${relayPort}`, {
      proxyIdPath: idPath,
      version: "0.6.2",
    });
    conn.on("relay_version", (version: string) => relayVersions.push(version));
    conn.connect();

    await waitForProxyRegistration(conn);
    await vi.waitFor(() => expect(relayVersions).toHaveLength(1));
    expect(relayVersions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(relay.registry.listProxiesWithName()).toContainEqual(
      expect.objectContaining({ proxyId: conn.getProxyId(), version: "0.6.2" }),
    );
  });

  it("completes real WebSocket registration with future response fields and exchanges messages", async () => {
    const futureRelay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const received: Record<string, unknown>[] = [];
    const connected = vi.fn();
    const disconnected = vi.fn();
    const relayVersion = vi.fn();
    const streamConnection = vi.fn();
    const message = vi.fn();
    const forwarded = { type: "session_list_request", requestId: "after-admission" };
    const queued = { type: "session_list", sessions: [] };
    let connectionCount = 0;
    futureRelay.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(request);
        if (request.type !== "proxy_register") return;
        socket.send(
          JSON.stringify({
            type: "proxy_register_response",
            protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
            status: "new",
            relayVersion: "0.9.0",
            connectionId: "connection-with-extensions",
            futureDescription: { label: "Future relay metadata" },
            futureCapabilities: ["optional-feature"],
          }),
        );
        socket.send(JSON.stringify(forwarded));
      });
    });

    try {
      await new Promise<void>((resolve) => futureRelay.once("listening", resolve));
      const address = futureRelay.address();
      if (!address || typeof address === "string") throw new Error("test relay did not listen");
      const tmpDir = mkdtempSync(join(tmpdir(), "relay-future-fields-test-"));
      conn = new RelayConnection(`ws://127.0.0.1:${address.port}`, {
        proxyIdPath: join(tmpDir, "proxy-id"),
      });
      conn.on("connected", connected);
      conn.on("disconnected", disconnected);
      conn.on("relay_version", relayVersion);
      conn.on("stream_connection", streamConnection);
      conn.on("message", message);
      conn.sendRaw(JSON.stringify(queued));
      conn.connect();

      await vi.waitFor(() => expect(message).toHaveBeenCalledExactlyOnceWith(forwarded));
      await vi.waitFor(() => expect(received).toContainEqual(queued));
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({
        type: "proxy_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        proxyId: conn.getProxyId(),
      });
      expect(conn.getStatus()).toMatchObject({
        connectionState: RelayConnectionState.SYNCED,
        connected: true,
        reconnectAttempt: 0,
        queueDepth: 0,
      });
      expect(connected).toHaveBeenCalledTimes(1);
      expect(relayVersion).toHaveBeenCalledExactlyOnceWith("0.9.0");
      expect(streamConnection).toHaveBeenCalledExactlyOnceWith("connection-with-extensions");
      expect(disconnected).not.toHaveBeenCalled();
      expect(connectionCount).toBe(1);
    } finally {
      conn?.close();
      conn = null;
      for (const socket of futureRelay.clients) socket.terminate();
      await new Promise<void>((resolve) => futureRelay.close(() => resolve()));
    }
  });

  it("sends MessageEnvelope to relay via sendEnvelope()", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    conn.connect();

    await waitForProxyRegistration(conn);

    const envelope = buildMessage(
      "assistant_message",
      "test-session",
      1,
      { turnId: "turn-1", revision: 1, text: "hello", status: "completed" },
      "proxy",
    );

    // send 不应抛异常
    expect(() => conn!.sendEnvelope(envelope)).not.toThrow();
  });

  it("never compresses binary PTY frames", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    conn.connect();
    await waitForProxyRegistration(conn);
    await vi.waitFor(() => expect(conn!.getStatus().connected).toBe(true));

    const relaySocket = (conn as unknown as { ws: WebSocket }).ws;
    const sendSpy = vi.spyOn(relaySocket, "send");
    const frame = new Uint8Array([2, 0x73, 0x31, 0x41]);
    conn.sendBinary(frame);

    expect(sendSpy).toHaveBeenCalledWith(frame, { binary: true, compress: false });
  });

  it("emits 'message' event when relay forwards a message", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    conn.connect();

    await waitForProxyRegistration(conn);

    const received: Record<string, unknown>[] = [];
    conn.on("message", (msg: Record<string, unknown>) => {
      received.push(msg);
    });

    // 通过 relay 的 registry 直接向 proxy 发送消息来模拟 relay 转发
    const proxyId = conn.getProxyId();
    const proxySocket = relay.registry.getProxy(proxyId);
    expect(proxySocket).toBeTruthy();

    const testPayload = { type: "test", data: "from-relay" };
    proxySocket!.send(JSON.stringify(testPayload));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(testPayload);
  });

  it("close() cleanly closes the WebSocket", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    conn.connect();

    await waitForProxyRegistration(conn);

    const proxyId = conn.getProxyId();
    expect(relay.registry.getProxy(proxyId)).toBeTruthy();

    conn.close();

    // 关闭后 proxy 应该从 registry 中移除
    await vi.waitFor(() => expect(relay.registry.getProxy(proxyId)).toBeUndefined());
    conn = null;
  });

  it("reads proxyId from config file or generates new one with nanoid and persists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    // 第一次创建时应该生成并持久化
    const conn1 = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    const id1 = conn1.getProxyId();
    expect(id1.length).toBe(21); // nanoid 默认长度
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf-8").trim()).toBe(id1);

    // 第二次创建时应该读取已有的 proxyId
    const conn2 = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });
    const id2 = conn2.getProxyId();
    expect(id2).toBe(id1);
  });

  it("transitions to WAITING_RECONNECT after a failed initial connect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    // 连接到一个不存在的端口
    conn = new RelayConnection("ws://localhost:19999", { proxyIdPath: idPath });

    // connect() 不应抛异常
    expect(() => conn!.connect()).not.toThrow();

    // 必须落到 WAITING_RECONNECT；停留在 CONNECTING 表示状态机失败处理被吞掉了
    await vi.waitFor(() =>
      expect(conn!.getStatus().connectionState).toBe(RelayConnectionState.WAITING_RECONNECT),
    );
  });

  it("emits 'connected' event on successful connect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });

    conn.connect();
    await connected;

    await waitForProxyRegistration(conn);
    expect(relay.registry.getProxy(conn.getProxyId())).toBeDefined();
  });

  it("emits 'disconnected' event on unexpected close", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForProxyRegistration(conn);

    const disconnected = new Promise<void>((resolve) => {
      conn!.on("disconnected", () => resolve());
    });

    // 通过 relay 端 terminate 来模拟非预期断开
    const proxyId = conn.getProxyId();
    const proxySocket = relay.registry.getProxy(proxyId);
    proxySocket!.terminate();

    await disconnected;
  });

  it("queues messages when disconnected instead of dropping", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForProxyRegistration(conn);

    // 断开连接
    const disconnected = new Promise<void>((resolve) => {
      conn!.on("disconnected", () => resolve());
    });
    const proxySocket = relay.registry.getProxy(conn.getProxyId());
    proxySocket!.terminate();
    await disconnected;

    // 在断开状态下发送消息，不应抛异常
    const envelope = buildMessage(
      "assistant_message",
      "test-session",
      1,
      { turnId: "turn-2", revision: 1, text: "queued", status: "completed" },
      "proxy",
    );
    expect(() => conn!.sendEnvelope(envelope)).not.toThrow();
  });

  it("reconnects automatically after unexpected close", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    let connectedCount = 0;
    conn.on("connected", () => {
      connectedCount++;
    });

    const firstConnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    conn.connect();
    await firstConnected;
    await waitForProxyRegistration(conn);

    const proxyId = conn.getProxyId();

    // 模拟断开
    const proxySocket = relay.registry.getProxy(proxyId);
    proxySocket!.terminate();

    // 等待自动重连
    const reconnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    await reconnected;
    await waitForProxyRegistration(conn);

    // 验证重连后 proxy 仍然使用同一个 proxyId 注册
    expect(relay.registry.getProxy(proxyId)).toBeDefined();
    expect(connectedCount).toBe(2);
  });

  it("close() does not trigger reconnect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForProxyRegistration(conn);

    let disconnectedEmitted = false;
    conn.on("disconnected", () => {
      disconnectedEmitted = true;
    });

    conn.close();

    // close() 是主动关闭，不应触发 disconnected 事件
    await vi.waitFor(() => expect(relay.registry.getProxy(conn!.getProxyId())).toBeUndefined());
    expect(disconnectedEmitted).toBe(false);
    conn = null;
  });

  it("flushes queued messages on reconnect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, { proxyIdPath: idPath });

    const firstConnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    conn.connect();
    await firstConnected;
    await waitForProxyRegistration(conn);

    const proxyId = conn.getProxyId();

    // 断开
    const disconnected = new Promise<void>((resolve) => {
      conn!.on("disconnected", () => resolve());
    });
    relay.registry.getProxy(proxyId)!.terminate();
    await disconnected;

    // 在离线时发送消息
    const envelope = buildMessage(
      "assistant_message",
      "sess-1",
      1,
      { turnId: "turn-3", revision: 1, text: "buffered-msg", status: "completed" },
      "proxy",
    );
    conn.sendEnvelope(envelope);

    // 等待重连
    const reconnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    await reconnected;
    await waitForProxyRegistration(conn);

    // 重连后的 proxy socket 应该收到了 flush 的消息
    expect(relay.registry.getProxy(proxyId)).toBeDefined();
  });
});
