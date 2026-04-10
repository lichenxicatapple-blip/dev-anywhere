import { describe, it, expect, vi, beforeEach } from "vitest";
import { RelayClient } from "../services/relay-client.js";
import type { WebSocketManager } from "../services/websocket.js";

function createMockWs(): WebSocketManager {
  return {
    send: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
    isConnected: vi.fn(() => true),
  } as unknown as WebSocketManager;
}

describe("RelayClient", () => {
  let ws: WebSocketManager;
  let client: RelayClient;

  beforeEach(() => {
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

  it("selectProxy sends proxy_select with proxyId", () => {
    client.selectProxy("proxy-abc");
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "proxy_select",
        proxyId: "proxy-abc",
      }),
    );
  });

  it("listProxies sends proxy_list_request", () => {
    client.listProxies();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "proxy_list_request",
      }),
    );
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
