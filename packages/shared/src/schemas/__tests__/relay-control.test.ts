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

  // Phase 5: client_register
  it("parses client_register with clientId and sessions", () => {
    const result = RelayControlSchema.parse({
      type: "client_register",
      clientId: "client-001",
      sessions: { s1: 42, s2: 10 },
    });
    expect(result).toEqual({
      type: "client_register",
      clientId: "client-001",
      sessions: { s1: 42, s2: 10 },
    });
  });

  it("parses client_register without sessions (new client)", () => {
    const result = RelayControlSchema.parse({
      type: "client_register",
      clientId: "client-002",
    });
    expect(result).toEqual({
      type: "client_register",
      clientId: "client-002",
    });
  });

  it("rejects client_register with empty clientId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "client_register", clientId: "" }),
    ).toThrow();
  });

  // Phase 5: client_register_response
  it("parses client_register_response with status restored", () => {
    const result = RelayControlSchema.parse({
      type: "client_register_response",
      status: "restored",
      proxyId: "proxy-abc",
    });
    expect(result).toEqual({
      type: "client_register_response",
      status: "restored",
      proxyId: "proxy-abc",
    });
  });

  it("parses client_register_response with status new and no proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "client_register_response",
      status: "new",
    });
    expect(result).toEqual({
      type: "client_register_response",
      status: "new",
    });
  });

  it("parses client_register_response with status proxy_offline", () => {
    const result = RelayControlSchema.parse({
      type: "client_register_response",
      status: "proxy_offline",
    });
    expect(result).toEqual({
      type: "client_register_response",
      status: "proxy_offline",
    });
  });

  it("rejects client_register_response with unknown status", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "client_register_response", status: "invalid" }),
    ).toThrow();
  });

  // Phase 5: replay_request
  it("parses replay_request with sessionId, fromSeq, toSeq", () => {
    const result = RelayControlSchema.parse({
      type: "replay_request",
      sessionId: "sess-1",
      fromSeq: 0,
      toSeq: 10,
    });
    expect(result).toEqual({
      type: "replay_request",
      sessionId: "sess-1",
      fromSeq: 0,
      toSeq: 10,
    });
  });

  it("rejects replay_request with empty sessionId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "replay_request", sessionId: "", fromSeq: 0, toSeq: 10 }),
    ).toThrow();
  });

  // Phase 5: replay_response
  it("parses replay_response with sessionId and messages array", () => {
    const result = RelayControlSchema.parse({
      type: "replay_response",
      sessionId: "sess-1",
      messages: [{ type: "text", content: "hello" }],
    });
    expect(result).toEqual({
      type: "replay_response",
      sessionId: "sess-1",
      messages: [{ type: "text", content: "hello" }],
    });
  });

  it("parses replay_response with empty messages", () => {
    const result = RelayControlSchema.parse({
      type: "replay_response",
      sessionId: "sess-1",
      messages: [],
    });
    expect(result).toEqual({
      type: "replay_response",
      sessionId: "sess-1",
      messages: [],
    });
  });

  // Phase 5: gap_unrecoverable
  it("parses gap_unrecoverable with sessionId, fromSeq, toSeq", () => {
    const result = RelayControlSchema.parse({
      type: "gap_unrecoverable",
      sessionId: "sess-1",
      fromSeq: 5,
      toSeq: 15,
    });
    expect(result).toEqual({
      type: "gap_unrecoverable",
      sessionId: "sess-1",
      fromSeq: 5,
      toSeq: 15,
    });
  });

  it("rejects gap_unrecoverable with empty sessionId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "gap_unrecoverable", sessionId: "", fromSeq: 0, toSeq: 10 }),
    ).toThrow();
  });

  // Phase 5: proxy_offline
  it("parses proxy_offline with proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_offline",
      proxyId: "proxy-123",
    });
    expect(result).toEqual({
      type: "proxy_offline",
      proxyId: "proxy-123",
    });
  });

  it("rejects proxy_offline with missing proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_offline" }),
    ).toThrow();
  });

  // Regression: existing types still work
  it("still parses all existing types after Phase 5 extension", () => {
    expect(RelayControlSchema.parse({ type: "proxy_register", proxyId: "p1" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "proxy_list_request" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "proxy_list_response", proxies: [] })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "proxy_select", proxyId: "p1" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "relay_error", code: "E", message: "m" })).toBeTruthy();
  });

  // Phase 6: proxy_register name field
  it("parses proxy_register with optional name", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_register",
      proxyId: "p1",
      name: "my-dev-machine",
    });
    expect(result).toEqual({
      type: "proxy_register",
      proxyId: "p1",
      name: "my-dev-machine",
    });
  });

  // Phase 6: proxy_list_response name field
  it("parses proxy_list_response with optional name in proxies", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [{ proxyId: "p1", name: "laptop" }, { proxyId: "p2" }],
    });
    expect(result).toEqual({
      type: "proxy_list_response",
      proxies: [{ proxyId: "p1", name: "laptop" }, { proxyId: "p2" }],
    });
  });

  // Phase 6: dir_list_request
  it("parses dir_list_request", () => {
    const result = RelayControlSchema.parse({
      type: "dir_list_request",
      proxyId: "p1",
      path: "/home",
    });
    expect(result).toEqual({
      type: "dir_list_request",
      proxyId: "p1",
      path: "/home",
    });
  });

  // Phase 6: dir_list_response
  it("parses dir_list_response", () => {
    const result = RelayControlSchema.parse({
      type: "dir_list_response",
      entries: [{ name: "src", isDir: true }],
      path: "/home",
    });
    expect(result).toEqual({
      type: "dir_list_response",
      entries: [{ name: "src", isDir: true }],
      path: "/home",
    });
  });

  // Phase 6: command_list_push
  it("parses command_list_push", () => {
    const result = RelayControlSchema.parse({
      type: "command_list_push",
      commands: [
        { name: "/compact", description: "Compact conversation", source: "builtin" },
      ],
    });
    expect(result).toEqual({
      type: "command_list_push",
      commands: [
        { name: "/compact", description: "Compact conversation", source: "builtin" },
      ],
    });
  });

  // Phase 6: file_tree_push
  it("parses file_tree_push", () => {
    const result = RelayControlSchema.parse({
      type: "file_tree_push",
      path: "/home/src",
      entries: [{ name: "index.ts", isDir: false }],
    });
    expect(result).toEqual({
      type: "file_tree_push",
      path: "/home/src",
      entries: [{ name: "index.ts", isDir: false }],
    });
  });

  // Phase 6: session_history_request
  it("parses session_history_request", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_request",
    });
    expect(result).toEqual({ type: "session_history_request" });
  });

  // Phase 6: session_history_response
  it("parses session_history_response", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_response",
      sessions: [
        { id: "abc", title: "test", projectDir: "/home", updatedAt: 123 },
      ],
    });
    expect(result).toEqual({
      type: "session_history_response",
      sessions: [
        { id: "abc", title: "test", projectDir: "/home", updatedAt: 123 },
      ],
    });
  });

  // Regression: all Phase 6 types work
  it("still parses all existing types after Phase 6 extension", () => {
    expect(RelayControlSchema.parse({ type: "proxy_register", proxyId: "p1" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "proxy_list_request" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "proxy_list_response", proxies: [] })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "client_register", clientId: "c1" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "replay_request", sessionId: "s1", fromSeq: 0 })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "dir_list_request", proxyId: "p1", path: "/" })).toBeTruthy();
    expect(RelayControlSchema.parse({ type: "session_history_request" })).toBeTruthy();
  });
});
