import { describe, it, expect } from "vitest";
import { RelayControlSchema } from "../relay-control.js";

describe("RelayControlSchema", () => {
  it("parses proxy_register with proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_register",
      proxyId: "proxy-abc",
    });
    expect(result).toEqual({ type: "proxy_register", proxyId: "proxy-abc" });
  });

  it("rejects proxy_register with empty proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_register", proxyId: "" }),
    ).toThrow();
  });

  it("parses proxy_list_request", () => {
    const result = RelayControlSchema.parse({ type: "proxy_list_request" });
    expect(result).toEqual({ type: "proxy_list_request" });
  });

  it("parses proxy_list_response with proxies array", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [{ proxyId: "p1" }, { proxyId: "p2" }],
    });
    expect(result).toEqual({
      type: "proxy_list_response",
      proxies: [{ proxyId: "p1" }, { proxyId: "p2" }],
    });
  });

  it("parses proxy_list_response with empty proxies", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [],
    });
    expect(result).toEqual({ type: "proxy_list_response", proxies: [] });
  });

  it("parses proxy_select with proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select",
      proxyId: "proxy-xyz",
    });
    expect(result).toEqual({ type: "proxy_select", proxyId: "proxy-xyz" });
  });

  it("parses relay_error with code and message", () => {
    const result = RelayControlSchema.parse({
      type: "relay_error",
      code: "PROXY_NOT_FOUND",
      message: "Proxy not online",
    });
    expect(result).toEqual({
      type: "relay_error",
      code: "PROXY_NOT_FOUND",
      message: "Proxy not online",
    });
  });

  it("rejects unknown type", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "unknown_type" }),
    ).toThrow();
  });

  it("rejects proxy_select with empty proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_select", proxyId: "" }),
    ).toThrow();
  });
});
