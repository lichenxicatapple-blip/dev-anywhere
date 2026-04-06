import { describe, it, expect, beforeEach } from "vitest";
import { RelayRegistry } from "../registry.js";
import type { WebSocket } from "ws";

// 创建模拟 WebSocket 对象用于测试
function createMockWs(): WebSocket {
  return {
    readyState: 1, // OPEN
    close: () => {},
    terminate: () => {},
    send: () => {},
  } as unknown as WebSocket;
}

describe("RelayRegistry", () => {
  let registry: RelayRegistry;

  beforeEach(() => {
    registry = new RelayRegistry();
  });

  it("registerProxy adds proxy and getProxy returns it", () => {
    const ws = createMockWs();
    registry.registerProxy("p1", ws);
    expect(registry.getProxy("p1")).toBe(ws);
  });

  it("registerProxy replaces existing proxy with same id", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    let terminated = false;
    ws1.terminate = () => {
      terminated = true;
    };

    registry.registerProxy("p1", ws1);
    registry.registerProxy("p1", ws2);

    expect(registry.getProxy("p1")).toBe(ws2);
    expect(terminated).toBe(true);
  });

  it("unregisterProxy removes proxy", () => {
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
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    registry.registerProxy("p1", ws1);
    registry.registerProxy("p2", ws2);

    const list = registry.listProxies();
    expect(list).toContain("p1");
    expect(list).toContain("p2");
    expect(list).toHaveLength(2);
  });

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

  it("unbindClient does nothing for unknown client", () => {
    const clientWs = createMockWs();
    expect(() => registry.unbindClient(clientWs)).not.toThrow();
  });

  it("getClientsForProxy returns all clients bound to a proxyId", () => {
    const proxyWs = createMockWs();
    const client1 = createMockWs();
    const client2 = createMockWs();
    const client3 = createMockWs();

    registry.registerProxy("p1", proxyWs);
    registry.registerProxy("p2", createMockWs());

    registry.bindClient(client1, "p1");
    registry.bindClient(client2, "p1");
    registry.bindClient(client3, "p2");

    const clients = registry.getClientsForProxy("p1");
    expect(clients).toContain(client1);
    expect(clients).toContain(client2);
    expect(clients).not.toContain(client3);
    expect(clients).toHaveLength(2);
  });

  it("getBoundProxy returns the proxyId a client is bound to", () => {
    const proxyWs = createMockWs();
    const clientWs = createMockWs();
    registry.registerProxy("p1", proxyWs);
    registry.bindClient(clientWs, "p1");

    expect(registry.getBoundProxy(clientWs)).toBe("p1");
  });

  it("getBoundProxy returns undefined for unbound client", () => {
    const clientWs = createMockWs();
    expect(registry.getBoundProxy(clientWs)).toBeUndefined();
  });

  it("countClients returns number of bound clients", () => {
    const proxyWs = createMockWs();
    const client1 = createMockWs();
    const client2 = createMockWs();

    registry.registerProxy("p1", proxyWs);
    registry.bindClient(client1, "p1");
    registry.bindClient(client2, "p1");

    expect(registry.countClients()).toBe(2);
  });
});
