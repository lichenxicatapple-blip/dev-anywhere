import { describe, it, expect, vi, beforeEach } from "vitest";
import { RelayClient } from "@/services/relay-client";
import type { WebSocketManager } from "@/services/websocket";

// ws.onMessage 在 RelayClient 构造函数中调用，需要在创建 mock 时就捕获 handler
let wsRawHandler: ((raw: string) => void) | null = null;

function createMockWs(): WebSocketManager {
  return {
    send: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    onMessage: vi.fn((handler: (raw: string) => void) => {
      wsRawHandler = handler;
      return () => { wsRawHandler = null; };
    }),
    onStatusChange: vi.fn(() => () => {}),
    isConnected: vi.fn(() => true),
  } as unknown as WebSocketManager;
}

describe("RelayClient", () => {
  let ws: WebSocketManager;
  let client: RelayClient;

  beforeEach(() => {
    wsRawHandler = null;
    ws = createMockWs();
    client = new RelayClient(ws, "test-client-id");
  });

  it("register sends client_register with clientId and sessions", () => {
    client.register();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "client_register",
        clientId: "test-client-id",
        sessions: {},
      }),
    );
  });

  it("register includes updated session seq map", () => {
    client.updateSeq("session-1", 42);
    client.register();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "client_register",
        clientId: "test-client-id",
        sessions: { "session-1": 42 },
      }),
    );
  });

  it("selectProxy sends proxy_select and resolves on success ACK", async () => {
    const promise = client.selectProxy("proxy-abc");
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "proxy_select",
        proxyId: "proxy-abc",
      }),
    );
    // boundProxyId 在 ACK 之前不应设置
    expect(client.getBoundProxyId()).toBeNull();

    // 模拟 relay 返回 proxy_select_response
    wsRawHandler!(JSON.stringify({ type: "proxy_select_response", success: true, proxyId: "proxy-abc" }));

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.proxyId).toBe("proxy-abc");
    expect(client.getBoundProxyId()).toBe("proxy-abc");
  });

  it("selectProxy resolves with failure on error ACK", async () => {
    const promise = client.selectProxy("offline-proxy");

    wsRawHandler!(JSON.stringify({ type: "proxy_select_response", success: false, error: "Proxy not online" }));

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Proxy not online");
    expect(client.getBoundProxyId()).toBeNull();
  });

  it("requestProxyList sends request and resolves with proxies", async () => {
    const promise = client.requestProxyList();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "proxy_list_request" }),
    );

    wsRawHandler!(JSON.stringify({
      type: "proxy_list_response",
      proxies: [{ proxyId: "p1", online: true, sessions: ["s1"] }],
    }));

    const proxies = await promise;
    expect(proxies).toEqual([{ proxyId: "p1", online: true, sessions: ["s1"] }]);
  });

  it("listProxies sends proxy_list_request", () => {
    client.listProxies();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "proxy_list_request",
      }),
    );
  });

  it("onMessage parses valid JSON and dispatches to handler", () => {
    const messageHandler = vi.fn();
    client.onMessage(messageHandler);

    wsRawHandler!('{"type":"proxy_list_response","proxies":[]}');
    expect(messageHandler).toHaveBeenCalledWith({ type: "proxy_list_response", proxies: [] });
  });

  it("onMessage drops invalid JSON without crashing", () => {
    const messageHandler = vi.fn();
    client.onMessage(messageHandler);

    wsRawHandler!("not valid json {{{");
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it("onMessage unsubscribe stops receiving messages", () => {
    const messageHandler = vi.fn();
    const unsub = client.onMessage(messageHandler);

    wsRawHandler!('{"type":"test"}');
    expect(messageHandler).toHaveBeenCalledTimes(1);

    unsub();

    wsRawHandler!('{"type":"test2"}');
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it("sendControl sends JSON-stringified control message", () => {
    const msg = { type: "session_list" as const };
    client.sendControl(msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("sendEnvelope sends JSON-stringified envelope", () => {
    const envelope = {
      type: "user_input" as const,
      sessionId: "s1",
      seq: 1,
      source: "client" as const,
      timestamp: Date.now(),
      version: "1",
      payload: { text: "hello" },
    };
    client.sendEnvelope(envelope);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(envelope));
  });
});
