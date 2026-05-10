import { describe, it, expect, beforeEach, vi } from "vitest";
import { RelayRegistry } from "#src/registry.js";
import { WebSocket } from "ws";

// 创建模拟 WebSocket 对象用于测试
function createMockWs(readyState: number = WebSocket.OPEN): WebSocket {
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
      registry.bindClientById("c1", "p1", client1);
      registry.bindClientById("c2", "p1", client2);

      registry.unregisterProxy("p1");

      expect(registry.getClientBinding("c1")).toBeUndefined();
      expect(registry.getClientBinding("c2")).toBeUndefined();
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
      registry.transitionProxy("p1", "online", "offline");
      expect(registry.isProxyOnline("p1")).toBe(false);
    });

    it("returns false for unknown proxy", () => {
      expect(registry.isProxyOnline("unknown")).toBe(false);
    });
  });

  describe("proxy offline and reconnect", () => {
    it("transition online->offline clears ws but preserves entry + sessions for reconnect", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");

      registry.transitionProxy("p1", "online", "offline");

      expect(registry.getProxy("p1")).toBeUndefined();
      expect(registry.hasProxy("p1")).toBe(true);
      expect(registry.getSessionsForProxy("p1")).toContain("s1");
    });

    it("reconnect after offline restores state", () => {
      const ws1 = createMockWs();
      registry.registerProxy("p1", ws1);
      registry.addSessionToProxy("p1", "s1");

      registry.transitionProxy("p1", "online", "offline");
      expect(registry.getProxy("p1")).toBeUndefined();

      const ws2 = createMockWs();
      const status = registry.registerProxy("p1", ws2);
      expect(status).toBe("reconnected");
      expect(registry.getProxy("p1")).toBe(ws2);
      expect(registry.isProxyOnline("p1")).toBe(true);
    });

  });

  describe("session tracking", () => {
    it("addSessionToProxy tracks sessionId in proxy session set", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");
      registry.addSessionToProxy("p1", "s2");

      const sessions = registry.getSessionsForProxy("p1");
      expect(sessions).toContain("s1");
      expect(sessions).toContain("s2");
    });

    it("unregisterProxy cleans up sessions", () => {
      registry.registerProxy("p1", createMockWs());
      registry.addSessionToProxy("p1", "s1");
      registry.unregisterProxy("p1");
      expect(registry.getSessionsForProxy("p1")).toEqual([]);
    });
  });

  describe("client binding by id", () => {
    it("bindClientById and getClientBinding work correctly", () => {
      const ws = createMockWs();
      registry.registerProxy("p1", createMockWs());
      const bound = registry.bindClientById("c1", "p1", ws);
      expect(bound).toBe(true);

      const binding = registry.getClientBinding("c1");
      expect(binding?.proxyId).toBe("p1");
      expect(binding?.ws).toBe(ws);
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
      expect(binding?.proxyId).toBe("p1");
      expect(binding?.ws).toBeNull();
    });

    it("updateClientSocket updates ws for existing binding", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", ws1);

      registry.updateClientSocket("c1", ws2);
      expect(registry.getClientBinding("c1")?.ws).toBe(ws2);
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

  describe("countClients", () => {
    it("returns total bound clients", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs());
      registry.bindClientById("c2", "p1", createMockWs());
      expect(registry.countClients()).toBe(2);
    });

    it("excludes bindings whose ws has been unbound (clientId binding kept for reconnect)", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs());
      registry.bindClientById("c2", "p1", createMockWs());
      registry.unbindClientById("c1");
      expect(registry.countClients()).toBe(1);
    });

    it("excludes bindings whose ws is no longer OPEN", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs(WebSocket.CLOSED));
      registry.bindClientById("c2", "p1", createMockWs());
      expect(registry.countClients()).toBe(1);
    });
  });

  describe("getProxyDetail", () => {
    it("returns undefined for unknown proxy", () => {
      expect(registry.getProxyDetail("unknown")).toBeUndefined();
    });

    it("returns detail for online proxy with sessions", () => {
      const ws = createMockWs();
      registry.registerProxy("p1", ws, "MacBook");
      registry.addSessionToProxy("p1", "s1");
      registry.addSessionToProxy("p1", "s2");

      const detail = registry.getProxyDetail("p1");
      expect(detail?.proxyId).toBe("p1");
      expect(detail?.name).toBe("MacBook");
      expect(detail?.online).toBe(true);
      expect(detail?.sessions).toContain("s1");
      expect(detail?.sessions).toContain("s2");
      expect(detail?.disconnectedAt).toBeNull();
    });

    it("returns detail for offline proxy with disconnectedAt timestamp", () => {
      registry.registerProxy("p1", createMockWs());
      registry.transitionProxy("p1", "online", "offline");

      const detail = registry.getProxyDetail("p1");
      expect(detail?.online).toBe(false);
      // disconnectedAt 必须是接近 Date.now() 的合理时间戳（不是 0 / 远古值 / NaN）
      expect(detail?.disconnectedAt).toBeGreaterThan(Date.now() - 5_000);
    });

    it("omits name field when proxy has no name", () => {
      registry.registerProxy("p1", createMockWs());
      const detail = registry.getProxyDetail("p1");
      expect(detail && "name" in detail).toBe(false);
    });
  });

  describe("getClientDetails", () => {
    it("returns empty array when no clients bound", () => {
      expect(registry.getClientDetails()).toEqual([]);
    });

    it("returns all client bindings with online status", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs(WebSocket.OPEN));
      registry.bindClientById("c2", "p1", createMockWs(WebSocket.OPEN));

      const details = registry.getClientDetails();
      expect(details).toHaveLength(2);
      expect(details[0]).toEqual({
        clientId: "c1",
        proxyId: "p1",
        online: true,
        connectionState: "bound",
      });
      expect(details[1]).toEqual({
        clientId: "c2",
        proxyId: "p1",
        online: true,
        connectionState: "bound",
      });
    });

    it("shows offline status for unbound clients", () => {
      registry.registerProxy("p1", createMockWs());
      registry.bindClientById("c1", "p1", createMockWs());
      registry.unbindClientById("c1");

      const details = registry.getClientDetails();
      expect(details).toHaveLength(1);
      expect(details[0].online).toBe(false);
    });
  });

  describe("state transitions", () => {
    describe("proxy connection state", () => {
      it("getProxyConnectionState returns 'online' after registration", () => {
        registry.registerProxy("p1", createMockWs());
        expect(registry.getProxyConnectionState("p1")).toBe("online");
      });

      it("getProxyConnectionState returns 'offline' after transitionProxy to offline", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        expect(registry.getProxyConnectionState("p1")).toBe("offline");
      });

      it("getProxyConnectionState returns undefined for unknown proxy", () => {
        expect(registry.getProxyConnectionState("unknown")).toBeUndefined();
      });

      it("transitionProxy online->offline succeeds", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        expect(registry.getProxyConnectionState("p1")).toBe("offline");
      });

      it("transitionProxy offline->online succeeds", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        registry.transitionProxy("p1", "offline", "online");
        expect(registry.getProxyConnectionState("p1")).toBe("online");
      });

      it("transitionProxy online->online throws (same state)", () => {
        registry.registerProxy("p1", createMockWs());
        expect(() => registry.transitionProxy("p1", "online", "online")).toThrow();
      });

      it("transitionProxy offline->offline throws (same state)", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        expect(() => registry.transitionProxy("p1", "offline", "offline")).toThrow();
      });

      it("transitionProxy throws for unknown proxy", () => {
        expect(() => registry.transitionProxy("unknown", "online", "offline")).toThrow();
      });

      it("transitionProxy throws on from-state mismatch", () => {
        registry.registerProxy("p1", createMockWs());
        expect(() => registry.transitionProxy("p1", "offline", "online")).toThrow();
      });

      it("transitionProxy to offline sets ws to null and disconnectedAt", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        expect(registry.getProxy("p1")).toBeUndefined();
        expect(registry.isProxyOnline("p1")).toBe(false);
      });

      it("reconnect sets connectionState back to online", () => {
        registry.registerProxy("p1", createMockWs());
        registry.transitionProxy("p1", "online", "offline");
        const ws2 = createMockWs();
        registry.registerProxy("p1", ws2);
        expect(registry.getProxyConnectionState("p1")).toBe("online");
      });
    });

    describe("client connection state", () => {
      it("getClientConnectionState returns 'bound' after bindClientById", () => {
        registry.registerProxy("p1", createMockWs());
        registry.bindClientById("c1", "p1", createMockWs());
        expect(registry.getClientConnectionState("c1")).toBe("bound");
      });

      it("getClientConnectionState returns undefined for unknown client", () => {
        expect(registry.getClientConnectionState("unknown")).toBeUndefined();
      });
    });

    describe("connectionState in detail APIs", () => {
      it("getProxyDetail includes connectionState field", () => {
        registry.registerProxy("p1", createMockWs());
        const detail = registry.getProxyDetail("p1");
        expect(detail!.connectionState).toBe("online");

        registry.transitionProxy("p1", "online", "offline");
        const detailOffline = registry.getProxyDetail("p1");
        expect(detailOffline!.connectionState).toBe("offline");
      });

      it("getClientDetails includes connectionState field", () => {
        registry.registerProxy("p1", createMockWs());
        registry.bindClientById("c1", "p1", createMockWs());

        const details = registry.getClientDetails();
        expect(details[0].connectionState).toBe("bound");
      });

      it("listProxiesWithName online field derives from connectionState", () => {
        registry.registerProxy("p1", createMockWs());
        let list = registry.listProxiesWithName();
        expect(list[0].online).toBe(true);

        registry.transitionProxy("p1", "online", "offline");
        list = registry.listProxiesWithName();
        expect(list[0].online).toBe(false);
      });

      it("isProxyOnline reads from connectionState", () => {
        registry.registerProxy("p1", createMockWs());
        expect(registry.isProxyOnline("p1")).toBe(true);

        registry.transitionProxy("p1", "online", "offline");
        expect(registry.isProxyOnline("p1")).toBe(false);
      });
    });
  });
});
