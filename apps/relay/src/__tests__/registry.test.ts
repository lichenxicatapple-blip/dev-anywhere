import { describe, it, expect, beforeEach, vi } from "vitest";
import { RelayRegistry } from "../registry.js";
import { WebSocket } from "ws";

// 创建模拟 WebSocket 对象用于测试
function createMockWs(readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket;
}

describe("RelayRegistry", () => {
  let registry: RelayRegistry;

  beforeEach(() => {
    registry = new RelayRegistry();
  });

  describe("proxy registration", () => {
    it("registerProxy returns 'new' for first registration", () => {
      const ws = createMockWs();
      const status = registry.registerProxy("p1", ws);
      expect(status).toBe("new");
      expect(registry.getProxy("p1")).toBe(ws);
    });

    it("registerProxy returns 'reconnected' for re-registration", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.registerProxy("p1", ws1);
      const status = registry.registerProxy("p1", ws2);
      expect(status).toBe("reconnected");
      expect(registry.getProxy("p1")).toBe(ws2);
    });

    it("registerProxy terminates existing open connection on re-register", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.registerProxy("p1", ws1);
      registry.registerProxy("p1", ws2);
      expect(ws1.terminate).toHaveBeenCalled();
    });

    it("unregisterProxy removes proxy and cleans up", () => {
      const ws = createMockWs();
      registry.registerProxy("p1", ws);
      registry.unregisterProxy("p1");
      expect(registry.getProxy("p1")).toBeUndefined();
    });

    it("unregisterProxy unbinds all clients bound to that proxy", () => {
      const proxyWs = createMockWs();
      const client1 = createMockWs();
      const client2 = createMockWs();

      registry.registerProxy("p1", proxyWs);
      registry.bindClient(client1, "p1");
      registry.bindClient(client2, "p1");

      registry.unregisterProxy("p1");

      expect(registry.getBoundProxy(client1)).toBeUndefined();
      expect(registry.getBoundProxy(client2)).toBeUndefined();
    });

    it("listProxies returns all registered proxyIds", () => {
      registry.registerProxy("p1", createMockWs());
      registry.registerProxy("p2", createMockWs());
      const list = registry.listProxies();
      expect(list).toContain("p1");
      expect(list).toContain("p2");
      expect(list).toHaveLength(2);
    });
  });

  describe("isProxyOnline", () => {
    it("returns true when proxy ws is open", () => {
      registry.registerProxy("p1", createMockWs(WebSocket.OPEN));
      expect(registry.isProxyOnline("p1")).toBe(true);
    });

    it("returns false when proxy is offline", () => {
      registry.registerProxy("p1", createMockWs());
      registry.markProxyOffline("p1");
      expect(registry.isProxyOnline("p1")).toBe(false);
    });

    it("returns false for unknown proxy", () => {
      expect(registry.isProxyOnline("unknown")).toBe(false);
    });
  });

  describe("proxy offline and reconnect", () => {
    it("markProxyOffline sets ws to null and preserves state", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");
      registry.getOrCreateSessionBuffer("s1");

      registry.markProxyOffline("p1");

      expect(registry.getProxy("p1")).toBeUndefined();
      expect(registry.hasProxy("p1")).toBe(true);
      expect(registry.getSessionBuffer("s1")).toBeDefined();
    });

    it("state persists indefinitely after markProxyOffline", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");
      registry.getOrCreateSessionBuffer("s1");

      registry.markProxyOffline("p1");

      // 没有定时器，状态永远保留
      expect(registry.hasProxy("p1")).toBe(true);
      expect(registry.getSessionBuffer("s1")).toBeDefined();
    });

    it("reconnect after offline restores state", () => {
      const ws1 = createMockWs();
      registry.registerProxy("p1", ws1);
      registry.addSessionToProxy("p1", "s1");
      registry.getOrCreateSessionBuffer("s1");

      registry.markProxyOffline("p1");
      expect(registry.getProxy("p1")).toBeUndefined();

      const ws2 = createMockWs();
      const status = registry.registerProxy("p1", ws2);
      expect(status).toBe("reconnected");
      expect(registry.getProxy("p1")).toBe(ws2);
      expect(registry.isProxyOnline("p1")).toBe(true);
      expect(registry.getSessionBuffer("s1")).toBeDefined();
    });

    it("markProxyOffline does nothing for unknown proxy", () => {
      expect(() => registry.markProxyOffline("unknown")).not.toThrow();
    });
  });

  describe("session buffers", () => {
    it("getOrCreateSessionBuffer creates buffer on first access", () => {
      const buffer = registry.getOrCreateSessionBuffer("s1");
      expect(buffer).toBeDefined();
      expect(buffer.size()).toBe(0);
    });

    it("getOrCreateSessionBuffer returns same buffer on second access", () => {
      const buffer1 = registry.getOrCreateSessionBuffer("s1");
      const buffer2 = registry.getOrCreateSessionBuffer("s1");
      expect(buffer1).toBe(buffer2);
    });

    it("getSessionBuffer returns undefined for unknown session", () => {
      expect(registry.getSessionBuffer("unknown")).toBeUndefined();
    });

    it("addSessionToProxy tracks sessionId in proxy session set", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");
      registry.addSessionToProxy("p1", "s2");
      registry.getOrCreateSessionBuffer("s1");
      registry.getOrCreateSessionBuffer("s2");

      // 清理 proxy 时会话缓冲区也被清理
      registry.unregisterProxy("p1");
      expect(registry.getSessionBuffer("s1")).toBeUndefined();
      expect(registry.getSessionBuffer("s2")).toBeUndefined();
    });
  });

  describe("client binding by id", () => {
    it("bindClientById and getClientBinding work correctly", () => {
      const ws = createMockWs();
      registry.registerProxy("p1", createMockWs());
      const bound = registry.bindClientById("c1", "p1", ws);
      expect(bound).toBe(true);

      const binding = registry.getClientBinding("c1");
      expect(binding).toBeDefined();
      expect(binding!.proxyId).toBe("p1");
      expect(binding!.ws).toBe(ws);
    });

    it("bindClientById returns false for unknown proxy", () => {
      const ws = createMockWs();
      expect(registry.bindClientById("c1", "unknown", ws)).toBe(false);
    });

    it("unbindClientById clears ws but preserves binding for reconnect", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs());
      registry.unbindClientById("c1");
      const binding = registry.getClientBinding("c1");
      expect(binding).toBeDefined();
      expect(binding!.proxyId).toBe("p1");
      expect(binding!.ws).toBeNull();
    });

    it("updateClientSocket updates ws for existing binding", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", ws1);

      registry.updateClientSocket("c1", ws2);
      expect(registry.getClientBinding("c1")!.ws).toBe(ws2);
    });

    it("getClientsForProxy includes clientId-bound clients", () => {
      const proxyWs = createMockWs();
      const clientWs = createMockWs();
      registry.registerProxy("p1", proxyWs);
      registry.bindClientById("c1", "p1", clientWs);

      const clients = registry.getClientsForProxy("p1");
      expect(clients).toContain(clientWs);
    });
  });

  describe("legacy client binding", () => {
    it("bindClient associates client with proxyId", () => {
      const proxyWs = createMockWs();
      const clientWs = createMockWs();
      registry.registerProxy("p1", proxyWs);

      const result = registry.bindClient(clientWs, "p1");
      expect(result).toBe(true);
      expect(registry.getBoundProxy(clientWs)).toBe("p1");
    });

    it("bindClient returns false if proxyId not registered", () => {
      const clientWs = createMockWs();
      const result = registry.bindClient(clientWs, "nonexistent");
      expect(result).toBe(false);
    });

    it("unbindClient removes client binding", () => {
      const proxyWs = createMockWs();
      const clientWs = createMockWs();
      registry.registerProxy("p1", proxyWs);
      registry.bindClient(clientWs, "p1");

      registry.unbindClient(clientWs);
      expect(registry.getBoundProxy(clientWs)).toBeUndefined();
    });

    it("getClientsForProxy returns legacy-bound clients", () => {
      const proxyWs = createMockWs();
      const client1 = createMockWs();
      const client2 = createMockWs();

      registry.registerProxy("p1", proxyWs);
      registry.bindClient(client1, "p1");
      registry.bindClient(client2, "p1");

      const clients = registry.getClientsForProxy("p1");
      expect(clients).toContain(client1);
      expect(clients).toContain(client2);
    });

    it("getBoundProxy returns undefined for unbound client", () => {
      const clientWs = createMockWs();
      expect(registry.getBoundProxy(clientWs)).toBeUndefined();
    });

    it("countClients returns total bound clients", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClient(createMockWs(), "p1");
      registry.bindClientById("c1", "p1", createMockWs());
      expect(registry.countClients()).toBe(2);
    });
  });

  describe("getBufferStats", () => {
    it("returns accurate counts", () => {
      registry.registerProxy("p1", createMockWs());
      registry.registerProxy("p2", createMockWs());

      const buf1 = registry.getOrCreateSessionBuffer("s1");
      buf1.append({ raw: "{}", seq: 1, type: "user_input", source: "proxy" });
      buf1.append({ raw: "{}", seq: 2, type: "assistant_message", source: "proxy" });

      const buf2 = registry.getOrCreateSessionBuffer("s2");
      buf2.append({ raw: "{}", seq: 1, type: "user_input", source: "proxy" });

      const stats = registry.getBufferStats();
      expect(stats.totalBuffered).toBe(3);
      expect(stats.sessionCount).toBe(2);
      expect(stats.proxyCount).toBe(2);
    });

    it("returns zeros when empty", () => {
      const stats = registry.getBufferStats();
      expect(stats.totalBuffered).toBe(0);
      expect(stats.sessionCount).toBe(0);
      expect(stats.proxyCount).toBe(0);
    });
  });
});
