import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMessage, routeProxyMessage, routeClientMessage } from "#src/router.js";
import { RelayRegistry } from "#src/registry.js";
import { WebSocket } from "ws";
import type { Logger } from "@dev-anywhere/shared";

function createMockWs(overrides: Record<string, unknown> = {}): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ...overrides,
  } as unknown as WebSocket;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

// 有效的 MessageEnvelope 测试数据
const validEnvelope = {
  seq: 1,
  sessionId: "sess-1",
  timestamp: Date.now(),
  source: "proxy" as const,
  version: "1.0",
  type: "assistant_message" as const,
  payload: { text: "hello", isPartial: false },
};

describe("parseMessage", () => {
  it("parses relay control message", () => {
    const data = JSON.stringify({ type: "proxy_register", proxyId: "p1" });
    const result = parseMessage(data);
    expect(result.kind).toBe("control");
    if (result.kind === "control") {
      expect(result.message.type).toBe("proxy_register");
    }
  });

  it("parses MessageEnvelope", () => {
    const data = JSON.stringify(validEnvelope);
    const result = parseMessage(data);
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      expect(result.message.type).toBe("assistant_message");
      expect(result.raw).toBe(data);
    }
  });

  it("returns invalid for bad JSON", () => {
    const result = parseMessage("not json {{{");
    expect(result.kind).toBe("invalid");
  });

  it("returns invalid for unknown structure", () => {
    const result = parseMessage(JSON.stringify({ foo: "bar" }));
    expect(result.kind).toBe("invalid");
  });
});

describe("routeProxyMessage", () => {
  let registry: RelayRegistry;
  let logger: Logger;

  beforeEach(() => {
    registry = new RelayRegistry();
    logger = createMockLogger();
  });

  it("forwards valid MessageEnvelope to all bound clients", () => {
    const proxyWs = createMockWs();
    const client1 = createMockWs();
    const client2 = createMockWs();

    registry.registerProxy("p1", proxyWs);
    registry.bindClientById("c1", "p1", client1);
    registry.bindClientById("c2", "p1", client2);

    const raw = JSON.stringify(validEnvelope);
    routeProxyMessage(raw, "p1", registry, logger);

    expect(client1.send).toHaveBeenCalledWith(raw);
    expect(client2.send).toHaveBeenCalledWith(raw);
  });

  it("logs warning for invalid JSON and does not forward", () => {
    const proxyWs = createMockWs();
    const client1 = createMockWs();

    registry.registerProxy("p1", proxyWs);
    registry.bindClientById("c1", "p1", client1);

    routeProxyMessage("invalid json", "p1", registry, logger);

    expect(client1.send).not.toHaveBeenCalled();
    // warn 必须带可定位的 proxyId + 解析错误，避免日志只剩 "warn 被调过"
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: "p1", error: expect.any(String) }),
      "Invalid message from proxy",
    );
  });

  it("no clients bound: silently drops without logging warn (not an error)", () => {
    const proxyWs = createMockWs();
    registry.registerProxy("p1", proxyWs);

    const raw = JSON.stringify(validEnvelope);
    routeProxyMessage(raw, "p1", registry, logger);

    // 没有 client 监听时直接丢弃是正常路径，不应触发 warn 日志
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips clients with non-OPEN readyState", () => {
    const proxyWs = createMockWs();
    const closedClient = createMockWs({ readyState: WebSocket.CLOSED });
    const openClient = createMockWs();

    registry.registerProxy("p1", proxyWs);
    registry.bindClientById("c-closed", "p1", closedClient);
    registry.bindClientById("c-open", "p1", openClient);

    const raw = JSON.stringify(validEnvelope);
    routeProxyMessage(raw, "p1", registry, logger);

    expect(closedClient.send).not.toHaveBeenCalled();
    expect(openClient.send).toHaveBeenCalledWith(raw);
  });
});

describe("routeClientMessage", () => {
  let registry: RelayRegistry;
  let logger: Logger;

  beforeEach(() => {
    registry = new RelayRegistry();
    logger = createMockLogger();
  });

  it("forwards valid MessageEnvelope to bound proxy", () => {
    const proxyWs = createMockWs();
    const clientWs = createMockWs();

    registry.registerProxy("p1", proxyWs);

    const clientEnvelope = { ...validEnvelope, source: "client" as const };
    const raw = JSON.stringify(clientEnvelope);
    routeClientMessage(raw, "p1", clientWs, registry, logger);

    expect(proxyWs.send).toHaveBeenCalledWith(raw);
  });

  it("sends relay_error when bound proxy is offline", () => {
    const proxyWs = createMockWs({ readyState: WebSocket.CLOSED });
    const clientWs = createMockWs();

    registry.registerProxy("p1", proxyWs);

    const raw = JSON.stringify({ ...validEnvelope, source: "client" as const });
    routeClientMessage(raw, "p1", clientWs, registry, logger);

    expect(clientWs.send).toHaveBeenCalled();
    const sentData = JSON.parse((clientWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(sentData.type).toBe("relay_error");
    expect(sentData.code).toBe("PROXY_OFFLINE");
  });

  it("logs warning for invalid data", () => {
    const clientWs = createMockWs();
    routeClientMessage("bad data {{", "p1", clientWs, registry, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      "Invalid message from client",
    );
    expect(clientWs.send).not.toHaveBeenCalled();
  });
});
