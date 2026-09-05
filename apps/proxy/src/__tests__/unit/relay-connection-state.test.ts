import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  encodeFileStreamFrame,
  ProxyProtocolAdmissionDirection,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayCloseCode,
} from "@dev-anywhere/shared";

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
    expect(JSON.parse(String(fakeWs.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "proxy_register",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
    });
  });

  it("does not emit queued business traffic or proxy_disconnect before admission", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    fakeWs.readyState = 1;
    fakeWs.emit("open");
    conn.sendRaw(JSON.stringify({ type: "session_list", sessions: [] }));

    expect(fakeWs.send.mock.calls.map(([raw]) => JSON.parse(String(raw)).type)).toEqual([
      "proxy_register",
    ]);
    conn.close();
    expect(fakeWs.send.mock.calls.map(([raw]) => JSON.parse(String(raw)).type)).toEqual([
      "proxy_register",
    ]);
  });

  it("retires a transport stuck in CONNECTING and schedules one backoff reconnect", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const mod = (await import("ws")) as unknown as MockWsModule;
    const initialSocketCount = mod.default.instances.length;
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      readyTimeoutMs: 20,
    });
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);

    try {
      conn.connect();
      const firstSocket = mod.default.lastInstance;
      if (!firstSocket) throw new Error("mock WebSocket did not capture instance");

      await vi.advanceTimersByTimeAsync(20);
      expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.WAITING_RECONNECT);
      expect(disconnected).toHaveBeenCalledTimes(1);

      // A late duplicate close from the retired socket must not create another timer.
      firstSocket.emit("close", 1006, Buffer.alloc(0));
      await vi.advanceTimersByTimeAsync(499);
      expect(mod.default.instances).toHaveLength(initialSocketCount + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mod.default.instances).toHaveLength(initialSocketCount + 2);
      expect(conn.getStatus()).toMatchObject({
        connectionState: RelayConnectionState.CONNECTING,
        reconnectAttempt: 1,
      });
    } finally {
      conn.close();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries an OPEN transport which never receives a registration response", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      readyTimeoutMs: 20,
    });

    try {
      conn.connect();
      const mod = (await import("ws")) as unknown as MockWsModule;
      const firstSocket = mod.default.lastInstance;
      if (!firstSocket) throw new Error("mock WebSocket did not capture instance");
      firstSocket.readyState = mod.default.OPEN;
      firstSocket.emit("open");
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.REGISTERING);

      await vi.advanceTimersByTimeAsync(20);
      expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.WAITING_RECONNECT);

      await vi.advanceTimersByTimeAsync(500);
      const secondSocket = mod.default.lastInstance;
      if (!secondSocket || secondSocket === firstSocket) {
        throw new Error("backoff did not create a replacement WebSocket");
      }
      secondSocket.readyState = mod.default.OPEN;
      secondSocket.emit("open");
      expect(conn.getStatus()).toMatchObject({
        connectionState: RelayConnectionState.REGISTERING,
        reconnectAttempt: 1,
      });
    } finally {
      conn.close();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clears the ready deadline and retry budget only after a valid registration response", async () => {
    vi.useFakeTimers();
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      readyTimeoutMs: 20,
    });

    try {
      conn.connect();
      const mod = (await import("ws")) as unknown as MockWsModule;
      const socket = mod.default.lastInstance;
      if (!socket) throw new Error("mock WebSocket did not capture instance");
      socket.readyState = mod.default.OPEN;
      socket.emit("open");
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "proxy_register_response",
            protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
            status: "new",
            relayVersion: "0.9.0",
            connectionId: "connection-ready",
          }),
        ),
      );

      expect(conn.getStatus()).toMatchObject({
        connectionState: RelayConnectionState.SYNCED,
        reconnectAttempt: 0,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.SYNCED);
    } finally {
      conn.close();
      vi.useRealTimers();
    }
  });

  it("emits the dedicated stream connection nonce from a successful registration", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    const nonces: string[] = [];
    conn.on("stream_connection", (connectionId: string) => nonces.push(connectionId));
    fakeWs.readyState = 1;
    fakeWs.emit("open");
    fakeWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_register_response",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          status: "new",
          relayVersion: "0.9.0",
          connectionId: "connection-1",
        }),
      ),
    );

    expect(nonces).toEqual(["connection-1"]);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", 0],
  ])("rejects a Relay registration response with a %s protocol", async (_label, version) => {
    const { conn, fakeWs } = await connectAndGrabWs();
    const connected = vi.fn();
    conn.on("connected", connected);
    fakeWs.readyState = 1;
    fakeWs.emit("open");
    const response: Record<string, unknown> = {
      type: "proxy_register_response",
      protocolVersion: version,
      status: "new",
      relayVersion: "0.9.0",
      connectionId: "connection-1",
    };
    if (version === undefined) delete response.protocolVersion;

    fakeWs.emit("message", Buffer.from(JSON.stringify(response)));

    expect(fakeWs.close).toHaveBeenCalledWith(
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
    );
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
    expect(connected).not.toHaveBeenCalled();
  });

  it("rejects without syncing when registration response omits connectionId", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    const connected = vi.fn();
    const streamConnection = vi.fn();
    conn.on("connected", connected);
    conn.on("stream_connection", streamConnection);
    fakeWs.readyState = 1;
    fakeWs.emit("open");

    fakeWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_register_response",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          status: "new",
          relayVersion: "0.9.0",
        }),
      ),
    );

    expect(fakeWs.close).toHaveBeenCalledWith(
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
    );
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
    expect(connected).not.toHaveBeenCalled();
    expect(streamConnection).not.toHaveBeenCalled();
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
    const resp = JSON.stringify({
      type: "proxy_register_response",
      protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      status: "new",
      relayVersion: "0.9.0",
      connectionId: "connection-1",
    });
    // register_response 在 CLOSED 态应被忽略：不改状态、不泄露为 message
    fakeWs.emit("message", Buffer.from(resp));
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
    expect(leaked).toEqual([]);
  });

  it("emits exactly one disconnect when a synced socket violates registration protocol", async () => {
    const { conn, fakeWs } = await connectAndGrabWs();
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);
    fakeWs.readyState = 1;
    fakeWs.emit("open");
    const response = Buffer.from(
      JSON.stringify({
        type: "proxy_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
        relayVersion: "0.9.0",
        connectionId: "connection-1",
      }),
    );
    fakeWs.emit("message", response);
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.SYNCED);

    // Real WebSocket close handshakes complete asynchronously and normally echo our 4405 code.
    // Do not let the default synchronous mock hide a duplicate-disconnect race.
    fakeWs.close.mockImplementationOnce(() => {
      fakeWs.readyState = 2;
    });
    fakeWs.emit("message", response);
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CLOSED);
    expect(fakeWs.close).toHaveBeenCalledWith(
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH,
    );
    expect(disconnected).toHaveBeenCalledTimes(1);

    // Complete the asynchronous close handshake with the same permanent code we sent.
    fakeWs.emit("close", RelayCloseCode.PROXY_PROTOCOL_REJECTED, Buffer.alloc(0));
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("blocks without WebSocket retries when Relay reports that it is outdated", async () => {
    vi.useFakeTimers();
    const mod = (await import("ws")) as unknown as MockWsModule;
    const initialSocketCount = mod.default.instances.length;
    const { conn, fakeWs } = await connectAndGrabWs();
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);
    fakeWs.readyState = mod.default.OPEN;
    fakeWs.emit("open");

    fakeWs.emit(
      "close",
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      Buffer.from(ProxyProtocolAdmissionDirection.RELAY_OUTDATED),
    );
    expect(conn.getStatus()).toMatchObject({
      connectionState: RelayConnectionState.BLOCKED_REMOTE,
      protocolAdmissionDirection: ProxyProtocolAdmissionDirection.RELAY_OUTDATED,
    });
    expect(disconnected).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mod.default.instances).toHaveLength(initialSocketCount + 1);

    conn.applyProtocolAdmission(ProxyProtocolAdmissionDirection.RELAY_OUTDATED);
    expect(disconnected).toHaveBeenCalledTimes(1);
    conn.applyProtocolAdmission(ProxyProtocolAdmissionDirection.COMPATIBLE);
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CONNECTING);
    expect(mod.default.instances).toHaveLength(initialSocketCount + 2);
    conn.close();
    vi.useRealTimers();
  });

  it.each([
    [
      ProxyProtocolAdmissionDirection.PROXY_OUTDATED,
      ProxyProtocolAdmissionDirection.PROXY_OUTDATED,
    ],
    ["unknown_reason", ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
  ])("fails closed without retries for permanent admission reason %s", async (reason, expected) => {
    vi.useFakeTimers();
    const mod = (await import("ws")) as unknown as MockWsModule;
    const initialSocketCount = mod.default.instances.length;
    const { conn, fakeWs } = await connectAndGrabWs();
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);
    fakeWs.readyState = mod.default.OPEN;
    fakeWs.emit("open");
    fakeWs.emit("close", RelayCloseCode.PROXY_PROTOCOL_REJECTED, Buffer.from(reason));

    expect(conn.getStatus()).toMatchObject({
      connectionState: RelayConnectionState.CLOSED,
      protocolAdmissionDirection: expected,
    });
    expect(disconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mod.default.instances).toHaveLength(initialSocketCount + 1);
    vi.useRealTimers();
  });

  it("lets HTTP admission win a WebSocket race without duplicate disconnect or reconnect", async () => {
    const mod = (await import("ws")) as unknown as MockWsModule;
    const initialSocketCount = mod.default.instances.length;
    const { conn, fakeWs } = await connectAndGrabWs();
    const disconnected = vi.fn();
    conn.on("disconnected", disconnected);
    fakeWs.readyState = mod.default.OPEN;
    fakeWs.emit("open");

    // HTTP discovers the older Relay while this WebSocket is still awaiting registration.
    conn.applyProtocolAdmission(ProxyProtocolAdmissionDirection.RELAY_OUTDATED);
    expect(fakeWs.terminate).toHaveBeenCalledTimes(1);
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.BLOCKED_REMOTE);
    expect(disconnected).toHaveBeenCalledTimes(1);

    // The retired socket's asynchronous close and a repeated HTTP observation are stale/idempotent.
    fakeWs.emit(
      "close",
      RelayCloseCode.PROXY_PROTOCOL_REJECTED,
      Buffer.from(ProxyProtocolAdmissionDirection.RELAY_OUTDATED),
    );
    conn.applyProtocolAdmission(ProxyProtocolAdmissionDirection.RELAY_OUTDATED);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(mod.default.instances).toHaveLength(initialSocketCount + 1);

    conn.applyProtocolAdmission(ProxyProtocolAdmissionDirection.COMPATIBLE);
    expect(mod.default.instances).toHaveLength(initialSocketCount + 2);
    expect(conn.getStatus().connectionState).toBe(RelayConnectionState.CONNECTING);
    conn.close();
  });

  it("terminates a half-open synced socket when heartbeat pong is missing", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 5,
    });
    try {
      conn.connect();
      const mod = (await import("ws")) as unknown as MockWsModule;
      const fakeWs = mod.default.lastInstance;
      if (!fakeWs) throw new Error("mock WebSocket did not capture instance");

      fakeWs.readyState = mod.default.OPEN;
      fakeWs.emit("open");
      fakeWs.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "proxy_register_response",
            protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
            status: "new",
            relayVersion: "0.9.0",
            connectionId: "connection-1",
          }),
        ),
      );
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.SYNCED);

      await vi.advanceTimersByTimeAsync(5);
      expect(fakeWs.ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5);
      expect(fakeWs.terminate).toHaveBeenCalledTimes(1);
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.WAITING_RECONNECT);
    } finally {
      conn.close();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("treats inbound upload data as connection liveness while awaiting pong", async () => {
    vi.useFakeTimers();
    const conn = new RelayConnection("ws://test:1234", {
      proxyIdPath: "/tmp/test-proxy-id",
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
    });
    try {
      conn.connect();
      const mod = (await import("ws")) as unknown as MockWsModule;
      const fakeWs = mod.default.lastInstance;
      if (!fakeWs) throw new Error("mock WebSocket did not capture instance");

      fakeWs.readyState = mod.default.OPEN;
      fakeWs.emit("open");
      fakeWs.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "proxy_register_response",
            protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
            status: "new",
            relayVersion: "0.9.0",
            connectionId: "connection-1",
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(fakeWs.ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40);
      fakeWs.emit(
        "message",
        Buffer.from(encodeFileStreamFrame("upload-1", 0, Buffer.from("upload data"))),
        true,
      );
      await vi.advanceTimersByTimeAsync(20);

      expect(fakeWs.terminate).not.toHaveBeenCalled();
      expect(conn.getStatus().connectionState).toBe(RelayConnectionState.SYNCED);
    } finally {
      conn.close();
      vi.useRealTimers();
    }
  });
});
