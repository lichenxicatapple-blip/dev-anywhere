import { describe, it, expect, vi } from "vitest";
import { ensureBinding, isBindingError } from "@/services/ensure-binding";
import type { RelayClient } from "@/services/relay-client";

function createMockRelay(overrides?: Partial<RelayClient>): RelayClient {
  return {
    getBoundProxyId: vi.fn(() => null),
    selectProxy: vi.fn(() => Promise.resolve({ success: true, proxyId: "p1" })),
    requestProxyList: vi.fn(() => Promise.resolve([])),
    ...overrides,
  } as unknown as RelayClient;
}

describe("ensureBinding", () => {
  it("already bound: returns immediately without calling selectProxy", async () => {
    const relay = createMockRelay({
      getBoundProxyId: vi.fn(() => "p1"),
    });

    const result = await ensureBinding(relay, { proxyId: "p1" });
    expect(isBindingError(result)).toBe(false);
    expect(result).toEqual({ proxyId: "p1" });
    expect(relay.selectProxy).not.toHaveBeenCalled();
  });

  it("user selection (proxyId given): calls selectProxy and returns proxyId", async () => {
    const relay = createMockRelay();

    const result = await ensureBinding(relay, { proxyId: "p1" });
    expect(isBindingError(result)).toBe(false);
    expect(result).toEqual({ proxyId: "p1" });
    expect(relay.selectProxy).toHaveBeenCalledWith("p1");
    expect(relay.requestProxyList).not.toHaveBeenCalled();
  });

  it("URL sessionId only: resolves via proxy_list then calls selectProxy", async () => {
    const relay = createMockRelay({
      requestProxyList: vi.fn(() => Promise.resolve([
        { proxyId: "p1", online: true, sessions: ["s1", "s2"] },
        { proxyId: "p2", online: true, sessions: ["s3"] },
      ])),
    });

    const result = await ensureBinding(relay, { sessionId: "s2" });
    expect(isBindingError(result)).toBe(false);
    expect(result).toEqual({ proxyId: "p1" });
    expect(relay.requestProxyList).toHaveBeenCalled();
    expect(relay.selectProxy).toHaveBeenCalledWith("p1");
  });

  it("URL sessionId not found: returns error without calling selectProxy", async () => {
    const relay = createMockRelay({
      requestProxyList: vi.fn(() => Promise.resolve([
        { proxyId: "p1", online: true, sessions: ["s1"] },
      ])),
    });

    const result = await ensureBinding(relay, { sessionId: "unknown" });
    expect(isBindingError(result)).toBe(true);
    if (isBindingError(result)) {
      expect(result.error).toContain("unknown");
      expect(result.error).toContain("not found");
    }
    expect(relay.selectProxy).not.toHaveBeenCalled();
  });

  it("selectProxy fails: returns error", async () => {
    const relay = createMockRelay({
      selectProxy: vi.fn(() => Promise.resolve({ success: false, error: "Proxy not online" })),
    });

    const result = await ensureBinding(relay, { proxyId: "p1" });
    expect(isBindingError(result)).toBe(true);
    if (isBindingError(result)) {
      expect(result.error).toBe("Proxy not online");
    }
  });

  it("no proxy specified: returns error", async () => {
    const relay = createMockRelay();

    const result = await ensureBinding(relay, {});
    expect(isBindingError(result)).toBe(true);
    if (isBindingError(result)) {
      expect(result.error).toBe("No proxy specified");
    }
    expect(relay.selectProxy).not.toHaveBeenCalled();
  });

  it("bound to different proxy: re-binds via selectProxy", async () => {
    const relay = createMockRelay({
      getBoundProxyId: vi.fn(() => "p1"),
      selectProxy: vi.fn(() => Promise.resolve({ success: true, proxyId: "p2" })),
    });

    const result = await ensureBinding(relay, { proxyId: "p2" });
    expect(isBindingError(result)).toBe(false);
    expect(result).toEqual({ proxyId: "p2" });
    expect(relay.selectProxy).toHaveBeenCalledWith("p2");
  });
});
