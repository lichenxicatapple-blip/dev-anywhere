import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// RelayConnectionState 需要从 relay-connection.ts 导出
import { RelayConnection, RelayConnectionState } from "#src/serve/relay-connection.js";

// mock ws 模块：用 EventEmitter 派生类，每次 new 把实例挂到 static lastInstance 供测试访问
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    send = vi.fn();
    ping = vi.fn((cb?: (err?: Error) => void) => {
      cb?.();
    });
    close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.alloc(0));
    });
    terminate = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1006, Buffer.alloc(0));
    });
    readyState = 0;
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static lastInstance: MockWebSocket | null = null;
    static instances: MockWebSocket[] = [];
    constructor(_url: string) {
      super();
      MockWebSocket.lastInstance = this;
      MockWebSocket.instances.push(this);
    }
  }
  return { default: MockWebSocket };
});

type MockWebSocketInstance = EventEmitter & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};
type MockWsModule = {
  default: {
    lastInstance: MockWebSocketInstance | null;
    instances: MockWebSocketInstance[];
    OPEN: number;
  };
};

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
    // atomicWriteFileSync 写 tmp 后 rename, 测试里 writeFileSync 已 stub 成 no-op,
    // rename 找不到源文件会抛 ENOENT, 这里也 stub 成 no-op。
    renameSync: vi.fn(),
  };
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

// 复现 ws 异步回调 vs. 同步 close() 的竞态：open/message 事件到达时 FSM 已 CLOSED，
// 当前 transitionTo 非法转换 throw 会冒到 unhandledException
describe("RelayConnection: async ws events arriving after close()", () => {
  async function connectAndGrabWs(): Promise<{
    conn: RelayConnection;
    fakeWs: MockWebSocketInstance;
  }> {
    const conn = new RelayConnection("ws://test:1234", { proxyIdPath: "/tmp/test-proxy-id" });
    conn.connect();
    const mod = (await import("ws")) as unknown as MockWsModule;
    const fakeWs = mod.default.lastInstance;
    if (!fakeWs) throw new Error("mock WebSocket did not capture instance");
    return { conn, fakeWs };
  }

  it("baseline: fakeWs mock takes effect, open → REGISTERING", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    fakeWs.readyState = 1;
    fakeWs.emit("open");
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.REGISTERING);
  });

  it("does not throw when ws 'open' fires after close() (race A)", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    conn.close();
    // 模拟 TCP 握手先于 close() 已完成，open 事件在 event loop 后到
    fakeWs.readyState = 1;
    expect(() => fakeWs.emit("open")).not.toThrow();
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
  });

  it("ignores register_response received after close() (CLOSED state)", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    fakeWs.readyState = 1;
    fakeWs.emit("open"); // 先 open 进 REGISTERING
    conn.close(); // 然后外部 close
    const leaked: unknown[] = [];
    conn.on("message", (msg: unknown) => leaked.push(msg));
    const resp = JSON.stringify({ type: "proxy_register_response", status: "ok" });
    // register_response 在 CLOSED 态应被忽略：不改状态、不泄露为 message
    fakeWs.emit("message", Buffer.from(resp));
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
    expect(leaked).toEqual([]);
  });

  it("terminates a half-open synced socket when heartbeat pong is missing", async () => {
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 5,
    });
    conn.connect();
    const mod = (await import("ws")) as unknown as MockWsModule;
    const fakeWs = mod.default.lastInstance;
    if (!fakeWs) throw new Error("mock WebSocket did not capture instance");

    fakeWs.readyState = mod.default.OPEN;
    fakeWs.emit("open");
    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "proxy_register_response", status: "ok" })),
    );
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.SYNCED);

    await vi.waitFor(() => expect(fakeWs.ping).toHaveBeenCalled(), { timeout: 100 });
    await vi.waitFor(() => expect(fakeWs.terminate).toHaveBeenCalled(), { timeout: 100 });
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.WAITING_RECONNECT);
    conn.close();
  });
});
