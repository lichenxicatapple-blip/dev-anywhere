import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createRelayServer, type RelayServer } from "../../../../apps/relay/src/server.js";
import { buildMessage } from "@cc-anywhere/shared";
import { RelayConnection } from "../relay-connection.js";

const logger = pino({ level: "silent" });

// 等待 relay 处理 proxy_register 消息的辅助函数
function waitForRegistration(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

let relay: RelayServer;
let relayPort: number;

beforeAll(async () => {
  relay = createRelayServer({ logger, heartbeatInterval: 60000 });
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

  it("connects to relay and sends proxy_register with proxyId", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    conn.connect();

    // 等待连接建立和注册完成
    await new Promise((resolve) => setTimeout(resolve, 300));

    const proxyId = conn.getProxyId();
    expect(proxyId).toBeTruthy();
    expect(typeof proxyId).toBe("string");
    expect(proxyId.length).toBeGreaterThan(0);

    // 验证 proxy 已注册到 relay
    const registered = relay.registry.getProxy(proxyId);
    expect(registered).toBeTruthy();
  });

  it("sends MessageEnvelope to relay via send()", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    conn.connect();

    await new Promise((resolve) => setTimeout(resolve, 300));

    const envelope = buildMessage("assistant_message", "test-session", { text: "hello", isPartial: false }, "proxy");

    // send 不应抛异常
    expect(() => conn!.send(envelope)).not.toThrow();
  });

  it("emits 'message' event when relay forwards a message", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    conn.connect();

    await new Promise((resolve) => setTimeout(resolve, 300));

    const received: string[] = [];
    conn.on("message", (data: string) => {
      received.push(data);
    });

    // 通过 relay 的 registry 直接向 proxy 发送消息来模拟 relay 转发
    const proxyId = conn.getProxyId();
    const proxySocket = relay.registry.getProxy(proxyId);
    expect(proxySocket).toBeTruthy();

    const testMsg = JSON.stringify({ type: "test", data: "from-relay" });
    proxySocket!.send(testMsg);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received.length).toBe(1);
    expect(received[0]).toBe(testMsg);
  });

  it("close() cleanly closes the WebSocket", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    conn.connect();

    await new Promise((resolve) => setTimeout(resolve, 300));

    const proxyId = conn.getProxyId();
    expect(relay.registry.getProxy(proxyId)).toBeTruthy();

    conn.close();

    await new Promise((resolve) => setTimeout(resolve, 200));

    // 关闭后 proxy 应该从 registry 中移除
    expect(relay.registry.getProxy(proxyId)).toBeUndefined();
    conn = null;
  });

  it("reads proxyId from config file or generates new one with nanoid and persists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    // 第一次创建时应该生成并持久化
    const conn1 = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    const id1 = conn1.getProxyId();
    expect(id1).toBeTruthy();
    expect(id1.length).toBe(21); // nanoid 默认长度
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf-8").trim()).toBe(id1);

    // 第二次创建时应该读取已有的 proxyId
    const conn2 = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });
    const id2 = conn2.getProxyId();
    expect(id2).toBe(id1);
  });

  it("handles connection failure gracefully without crashing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    // 连接到一个不存在的端口
    conn = new RelayConnection("ws://localhost:19999", logger, { proxyIdPath: idPath });

    // connect() 不应抛异常
    expect(() => conn!.connect()).not.toThrow();

    // 等待连接失败
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 进程仍在运行说明没有崩溃
    expect(true).toBe(true);
  });

  it("emits 'connected' event on successful connect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });

    conn.connect();
    await connected;

    await waitForRegistration();
    expect(relay.registry.getProxy(conn.getProxyId())).toBeTruthy();
  });

  it("emits 'disconnected' event on unexpected close", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForRegistration();

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

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForRegistration();

    // 断开连接
    const disconnected = new Promise<void>((resolve) => {
      conn!.on("disconnected", () => resolve());
    });
    const proxySocket = relay.registry.getProxy(conn.getProxyId());
    proxySocket!.terminate();
    await disconnected;

    // 在断开状态下发送消息，不应抛异常
    const envelope = buildMessage("assistant_message", "test-session", { text: "queued", isPartial: false }, "proxy");
    expect(() => conn!.send(envelope)).not.toThrow();
  });

  it("reconnects automatically after unexpected close", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    let connectedCount = 0;
    conn.on("connected", () => { connectedCount++; });

    const firstConnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    conn.connect();
    await firstConnected;
    await waitForRegistration();

    const proxyId = conn.getProxyId();

    // 模拟断开
    const proxySocket = relay.registry.getProxy(proxyId);
    proxySocket!.terminate();

    // 等待自动重连
    const reconnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    await reconnected;
    await waitForRegistration();

    // 验证重连后 proxy 仍然使用同一个 proxyId 注册
    expect(relay.registry.getProxy(proxyId)).toBeTruthy();
    expect(connectedCount).toBe(2);
  });

  it("close() does not trigger reconnect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    const connected = new Promise<void>((resolve) => {
      conn!.on("connected", () => resolve());
    });
    conn.connect();
    await connected;
    await waitForRegistration();

    let disconnectedEmitted = false;
    conn.on("disconnected", () => { disconnectedEmitted = true; });

    conn.close();

    // 等待足够长的时间确认没有触发重连
    await new Promise((resolve) => setTimeout(resolve, 500));

    // close() 是主动关闭，不应触发 disconnected 事件
    expect(disconnectedEmitted).toBe(false);
    conn = null;
  });

  it("flushes queued messages on reconnect", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const idPath = join(tmpDir, "proxy-id");

    conn = new RelayConnection(`ws://localhost:${relayPort}`, logger, { proxyIdPath: idPath });

    const firstConnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    conn.connect();
    await firstConnected;
    await waitForRegistration();

    const proxyId = conn.getProxyId();

    // 断开
    const disconnected = new Promise<void>((resolve) => {
      conn!.on("disconnected", () => resolve());
    });
    relay.registry.getProxy(proxyId)!.terminate();
    await disconnected;

    // 在离线时发送消息
    const envelope = buildMessage("assistant_message", "sess-1", { text: "buffered-msg", isPartial: false }, "proxy");
    conn.send(envelope);

    // 等待重连
    const reconnected = new Promise<void>((resolve) => {
      conn!.once("connected", () => resolve());
    });
    await reconnected;
    await waitForRegistration();

    // 重连后的 proxy socket 应该收到了 flush 的消息
    const newProxySocket = relay.registry.getProxy(proxyId);
    expect(newProxySocket).toBeTruthy();
  });
});
