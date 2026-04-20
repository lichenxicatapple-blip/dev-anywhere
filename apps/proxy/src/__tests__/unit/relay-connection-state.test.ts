import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// RelayConnectionState 需要从 relay-connection.ts 导出
import { RelayConnection, RelayConnectionState } from "#src/serve/relay-connection.js";

// mock ws 模块，避免实际 WebSocket 连接
vi.mock("ws", () => {
  const MockWebSocket = Object.assign(vi.fn(), {
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
  });
  return { default: MockWebSocket };
});

// mock nanoid
vi.mock("nanoid", () => ({
  nanoid: () => "test-proxy-id-12345",
}));

// mock fs 操作，避免文件系统依赖
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("proxy-id")) return false;
      return original.existsSync(path);
    }),
    readFileSync: original.readFileSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

describe("RelayConnectionState", () => {
  it("has all 6 state values", () => {
    expect(RelayConnectionState.DISCONNECTED).toBe("disconnected");
    expect(RelayConnectionState.CONNECTING).toBe("connecting");
    expect(RelayConnectionState.REGISTERING).toBe("registering");
    expect(RelayConnectionState.SYNCED).toBe("synced");
    expect(RelayConnectionState.WAITING_RECONNECT).toBe("waiting_reconnect");
    expect(RelayConnectionState.CLOSED).toBe("closed");
  });
});

describe("RelayConnection state machine", () => {
  let conn: RelayConnection;

  beforeEach(() => {
    conn = new RelayConnection("ws://test:1234", { proxyIdPath: "/tmp/test-proxy-id" });
  });

  afterEach(() => {
    conn.close();
    vi.restoreAllMocks();
  });

  it("starts in DISCONNECTED state", () => {
    const status = conn.getStatus();
    expect(status.connectionState).toBe(RelayConnectionState.DISCONNECTED);
  });

  it("getStatus includes connectionState field", () => {
    const status = conn.getStatus();
    expect(status).toHaveProperty("connectionState");
    expect(status).toHaveProperty("connected");
    expect(status).toHaveProperty("proxyId");
    expect(status).toHaveProperty("reconnectAttempt");
    expect(status).toHaveProperty("queueDepth");
  });

  it("close() sets CLOSED state", () => {
    conn.close();
    const status = conn.getStatus();
    expect(status.connectionState).toBe(RelayConnectionState.CLOSED);
  });

  it("sendRaw queues messages when not SYNCED", () => {
    // 初始 DISCONNECTED 状态，消息应入队
    conn.sendRaw('{"type":"test"}');
    conn.sendRaw('{"type":"test2"}');
    const status = conn.getStatus();
    expect(status.queueDepth).toBe(2);
  });

  it("sendRaw discards messages when CLOSED", () => {
    conn.close();
    conn.sendRaw('{"type":"test"}');
    const status = conn.getStatus();
    expect(status.queueDepth).toBe(0);
  });

  it("queue overflow drops oldest messages", () => {
    // 测试队列上限：连续发超过上限的消息，队列深度不超过上限
    const MAX_QUEUE = 10000;
    for (let i = 0; i < MAX_QUEUE + 100; i++) {
      conn.sendRaw(`{"seq":${i}}`);
    }
    const status = conn.getStatus();
    expect(status.queueDepth).toBe(MAX_QUEUE);
  });
});
