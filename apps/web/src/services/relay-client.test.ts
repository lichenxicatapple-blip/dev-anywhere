import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "./relay-client";

class FakeWebSocketManager {
  sent: string[] = [];
  connected = true;
  private messageHandlers = new Set<(data: string) => void>();
  private statusHandlers = new Set<(connected: boolean) => void>();

  send(data: string): boolean {
    this.sent.push(data);
    return this.connected;
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emit(payload: unknown): void {
    const data = JSON.stringify(payload);
    this.messageHandlers.forEach((handler) => handler(data));
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.statusHandlers.forEach((handler) => handler(connected));
  }
}

function sentRequestId(ws: FakeWebSocketManager, index = 0): string {
  const msg = JSON.parse(ws.sent[index] ?? "{}") as { requestId?: string };
  if (!msg.requestId) throw new Error(`missing requestId in sent message ${index}`);
  return msg.requestId;
}

function createClient(): { relay: RelayClient; ws: FakeWebSocketManager } {
  const ws = new FakeWebSocketManager();
  return {
    relay: new RelayClient(ws, "client-1"),
    ws,
  };
}

describe("RelayClient request handling", () => {
  it("resolves proxy list requests from the matching response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestProxyList();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "proxy_list_response",
      requestId,
      proxies: [{ proxyId: "proxy-1", online: true, sessions: ["s1"] }],
    });

    await expect(promise).resolves.toEqual([
      { proxyId: "proxy-1", online: true, sessions: ["s1"] },
    ]);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ type: "proxy_list_request" });
  });

  it("times out unanswered requests instead of leaving the UI pending forever", async () => {
    vi.useFakeTimers();
    try {
      const { relay } = createClient();
      const promise = relay.requestProxyList(100);
      const assertion = expect(promise).rejects.toThrow("请求开发机列表超时");

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when a request cannot be sent on a disconnected socket", async () => {
    const { relay, ws } = createClient();
    ws.connected = false;

    await expect(relay.selectProxy("proxy-1")).rejects.toThrow("连接已断开");
  });

  it("waits for the matching directory create response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.createDirectory("/Users/admin/new-project");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "dir_create_response",
      requestId: "other-request",
      path: "/Users/admin/new-project",
      success: true,
    });
    ws.emit({
      type: "dir_create_response",
      requestId,
      path: "/Users/admin/new-project",
      success: true,
    });

    await expect(promise).resolves.toEqual({
      path: "/Users/admin/new-project",
      success: true,
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for the matching directory list response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestDirectoryList("/Users/admin");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "dir_list_response",
      requestId: "other-request",
      path: "/Users/admin",
      entries: [{ name: "wrong", isDir: true }],
    });
    ws.emit({
      type: "dir_list_response",
      requestId,
      path: "/Users/admin",
      entries: [{ name: "workspace", isDir: true }],
    });

    await expect(promise).resolves.toEqual({
      path: "/Users/admin",
      entries: [{ name: "workspace", isDir: true }],
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for matching proxy info responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestProxyInfo();
    const requestId = sentRequestId(ws);

    ws.emit({ type: "proxy_info", requestId: "other-request", homePath: "/tmp" });
    ws.emit({ type: "proxy_info", requestId, homePath: "/Users/admin" });

    await expect(promise).resolves.toEqual({ homePath: "/Users/admin" });
  });

  it("waits for matching session history responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionHistory();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_history_response",
      requestId: "other-request",
      sessions: [{ id: "old", title: "old", projectDir: "/old", updatedAt: 1 }],
    });
    ws.emit({
      type: "session_history_response",
      requestId,
      sessions: [{ id: "new", title: "new", projectDir: "/new", updatedAt: 2 }],
    });

    await expect(promise).resolves.toEqual([
      { id: "new", title: "new", projectDir: "/new", updatedAt: 2 },
    ]);
  });

  it("waits for matching session message responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionMessages("s1");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_history_messages",
      requestId: "other-request",
      sessionId: "s1",
      messages: [{ role: "user", text: "wrong" }],
    });
    ws.emit({
      type: "session_history_messages",
      requestId,
      sessionId: "other-session",
      messages: [{ role: "user", text: "wrong session" }],
    });
    ws.emit({
      type: "session_history_messages",
      requestId,
      sessionId: "s1",
      messages: [{ role: "assistant", text: "hello" }],
    });

    await expect(promise).resolves.toEqual([{ role: "assistant", text: "hello" }]);
  });

  it("waits for matching agent status snapshots", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestAgentStatuses("s1");
    const requestId = sentRequestId(ws);

    ws.emit({ type: "agent_status_response", requestId: "other-request", statuses: [] });
    ws.emit({
      type: "agent_status_response",
      requestId,
      statuses: [
        {
          sessionId: "s1",
          payload: {
            provider: "claude",
            phase: "thinking",
            seq: 1,
            updatedAt: 1760000000000,
          },
        },
      ],
    });

    await expect(promise).resolves.toEqual([
      {
        sessionId: "s1",
        payload: {
          provider: "claude",
          phase: "thinking",
          seq: 1,
          updatedAt: 1760000000000,
        },
      },
    ]);
  });

  it("waits for matching session resource snapshots", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionResources("s1");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_resources_response",
      requestId: "other-request",
      sessionId: "s1",
      commands: [],
      groups: [],
    });
    ws.emit({
      type: "session_resources_response",
      requestId,
      sessionId: "other-session",
      commands: [],
      groups: [],
    });
    ws.emit({
      type: "session_resources_response",
      requestId,
      sessionId: "s1",
      commands: [{ name: "/init", description: "Initialize", source: "builtin" }],
      groups: [{ path: "/tmp", entries: [{ name: "src", isDir: true }] }],
    });

    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      commands: [{ name: "/init", description: "Initialize", source: "builtin" }],
      groups: [{ path: "/tmp", entries: [{ name: "src", isDir: true }] }],
      error: undefined,
      errorCode: undefined,
    });
  });

  it("correlates concurrent session create responses by requestId", async () => {
    const { relay, ws } = createClient();
    const first = relay.createSession({ cwd: "/one", provider: "claude", mode: "pty" });
    const second = relay.createSession({ cwd: "/two", provider: "codex", mode: "pty" });
    const firstRequestId = sentRequestId(ws, 0);
    const secondRequestId = sentRequestId(ws, 1);

    ws.emit({
      type: "session_create_response",
      requestId: secondRequestId,
      sessionId: "second-session",
      mode: "pty",
      provider: "codex",
    });
    ws.emit({
      type: "session_create_response",
      requestId: firstRequestId,
      sessionId: "first-session",
      mode: "pty",
      provider: "claude",
    });

    await expect(first).resolves.toMatchObject({ sessionId: "first-session" });
    await expect(second).resolves.toMatchObject({ sessionId: "second-session" });
  });
});
