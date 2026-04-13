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

  it("rejects terminal_scroll_request with non-positive delta", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "terminal_scroll_request",
        sessionId: "sess-1",
        direction: "up",
        delta: 0,
      }),
    ).toThrow();
  });

  it("parses valid terminal_scroll_request", () => {
    const result = RelayControlSchema.parse({
      type: "terminal_scroll_request",
      sessionId: "sess-1",
      direction: "up",
      delta: 5,
    });
    expect(result.type).toBe("terminal_scroll_request");
    if (result.type === "terminal_scroll_request") {
      expect(result.direction).toBe("up");
      expect(result.delta).toBe(5);
    }
  });

  it("parses proxy_list_response with proxies array", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", name: "my-laptop", online: true },
        { proxyId: "p2", online: false },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies).toHaveLength(2);
      expect(result.proxies[0]).toEqual({ proxyId: "p1", name: "my-laptop", online: true });
      expect(result.proxies[1]).toEqual({ proxyId: "p2", online: false });
    }
  });

  it("parses command_list_push with commands array", () => {
    const result = RelayControlSchema.parse({
      type: "command_list_push",
      commands: [
        { name: "/compact", description: "Compact history", source: "builtin" },
        { name: "/help", description: "Show help", argumentHint: "[topic]", source: "builtin" },
      ],
    });
    expect(result.type).toBe("command_list_push");
    if (result.type === "command_list_push") {
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].argumentHint).toBeUndefined();
      expect(result.commands[1].argumentHint).toBe("[topic]");
    }
  });

  it("parses dir_list_response with entries and path", () => {
    const result = RelayControlSchema.parse({
      type: "dir_list_response",
      path: "/home/user/project",
      entries: [
        { name: "src", isDir: true },
        { name: "README.md", isDir: false },
      ],
    });
    expect(result.type).toBe("dir_list_response");
    if (result.type === "dir_list_response") {
      expect(result.path).toBe("/home/user/project");
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({ name: "src", isDir: true });
    }
  });

  it("parses session_history_response with sessions array", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_response",
      sessions: [
        { id: "s1", title: "Fix bug", projectDir: "/project", updatedAt: 1700000000 },
      ],
    });
    expect(result.type).toBe("session_history_response");
    if (result.type === "session_history_response") {
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].title).toBe("Fix bug");
    }
  });

  it("parses file_tree_push with path and entries", () => {
    const result = RelayControlSchema.parse({
      type: "file_tree_push",
      path: "/project/src",
      entries: [{ name: "index.ts", isDir: false }],
    });
    expect(result.type).toBe("file_tree_push");
    if (result.type === "file_tree_push") {
      expect(result.entries[0].name).toBe("index.ts");
    }
  });

  it("rejects terminal_scroll_request with invalid direction", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "terminal_scroll_request",
        sessionId: "sess-1",
        direction: "left",
        delta: 5,
      }),
    ).toThrow();
  });

  it("parses proxy_select_response with success=true and proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: true,
      proxyId: "p1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response") {
      expect(result.success).toBe(true);
      expect(result.proxyId).toBe("p1");
    }
  });

  it("parses proxy_select_response with success=false and error", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: false,
      error: "Proxy not online: p1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response") {
      expect(result.success).toBe(false);
      expect(result.error).toBe("Proxy not online: p1");
    }
  });

  it("parses proxy_list_response with sessions field in ProxyInfo", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", online: true, sessions: ["s1", "s2"] },
        { proxyId: "p2", online: false },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies[0].sessions).toEqual(["s1", "s2"]);
      expect(result.proxies[1].sessions).toBeUndefined();
    }
  });

  it("rejects bind_by_session type (removed from schema)", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "bind_by_session", sessionId: "s1" }),
    ).toThrow();
  });

  it("rejects bind_by_session_response type (removed from schema)", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "bind_by_session_response", success: true, proxyId: "p1" }),
    ).toThrow();
  });
});
