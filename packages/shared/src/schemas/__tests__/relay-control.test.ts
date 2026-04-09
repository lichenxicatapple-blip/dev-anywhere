import { describe, it, expect } from "vitest";
import { RelayControlSchema } from "../relay-control.js";

describe("RelayControlSchema", () => {
  it("rejects proxy_register with empty proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_register", proxyId: "" }),
    ).toThrow();
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

  it("rejects client_register with empty clientId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "client_register", clientId: "" }),
    ).toThrow();
  });

  it("rejects client_register_response with unknown status", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "client_register_response", status: "invalid" }),
    ).toThrow();
  });

  it("rejects replay_request with empty sessionId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "replay_request", sessionId: "", fromSeq: 0, toSeq: 10 }),
    ).toThrow();
  });

  it("rejects gap_unrecoverable with empty sessionId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "gap_unrecoverable", sessionId: "", fromSeq: 0, toSeq: 10 }),
    ).toThrow();
  });

  it("rejects proxy_offline with missing proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_offline" }),
    ).toThrow();
  });

  it("rejects terminal_lines_request with non-positive count", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "terminal_lines_request",
        sessionId: "sess-1",
        fromLineId: 0,
        count: 0,
      }),
    ).toThrow();
  });

  it("parses terminal_lines_response with empty lines array", () => {
    const result = RelayControlSchema.parse({
      type: "terminal_lines_response",
      sessionId: "sess-1",
      fromLineId: 100,
      oldestLineId: 50,
      newestLineId: 200,
      lines: [],
    });
    expect(result.lines).toEqual([]);
  });
});
