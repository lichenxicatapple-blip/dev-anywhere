import { afterEach, describe, expect, it, vi } from "vitest";
import { HookRegistry } from "#src/serve/hook-registry.js";
import { HookServer, type AuthenticatedHookEvent } from "#src/serve/hook-server.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";

const servers: HookServer[] = [];

async function createTestServer(
  onEvent?: (event: AuthenticatedHookEvent) => void,
  options?: { isSessionActive?: (sessionId: string) => boolean },
) {
  const registry = new HookRegistry();
  const permissionBroker = new PermissionBroker();
  const server = new HookServer({
    port: 0,
    registry,
    permissionBroker,
    isSessionActive: options?.isSessionActive,
    onEvent,
  });
  await server.start();
  servers.push(server);
  const port = server.getListeningPort();
  if (!port) throw new Error("Hook test server did not expose a port");
  return { registry, permissionBroker, url: `http://127.0.0.1:${port}/hook` };
}

async function waitForPendingPermission(
  permissionBroker: PermissionBroker,
  sessionId: string,
): Promise<void> {
  await vi.waitFor(() => expect(permissionBroker.listSession(sessionId)).toHaveLength(1));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("HookServer", () => {
  it("accepts authenticated provider hook events", async () => {
    const events: AuthenticatedHookEvent[] = [];
    const { registry, url } = await createTestServer((event) => events.push(event));
    const credentials = registry.registerSession("s1", "claude");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "SessionStart",
        payload: { cwd: "/tmp/project" },
      }),
    });

    await expect(response.text()).resolves.toBe("");
    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        sessionId: "s1",
        provider: "claude",
        event: "SessionStart",
        payload: { cwd: "/tmp/project" },
      },
    ]);
  });

  it("rejects hook events with invalid credentials", async () => {
    const { registry, url } = await createTestServer();
    const credentials = registry.registerSession("s1", "claude");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "SessionStart",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_hook_credentials" });
  });

  it("acknowledges hooks for inactive preserved sessions without forwarding events", async () => {
    const events: AuthenticatedHookEvent[] = [];
    const { registry, url } = await createTestServer((event) => events.push(event), {
      isSessionActive: () => false,
    });
    const credentials = registry.registerSession("s1", "claude");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "SessionStart",
        payload: { cwd: "/tmp/project" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(events).toEqual([]);
  });

  it("holds PermissionRequest until the broker resolves it", async () => {
    const { registry, permissionBroker, url } = await createTestServer();
    const credentials = registry.registerSession("s1", "claude");

    const responsePromise = fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "PermissionRequest",
        requestId: "req-1",
        payload: { toolName: "Bash", input: { command: "pwd" } },
      }),
    });

    await waitForPendingPermission(permissionBroker, "s1");
    expect(permissionBroker.listSession("s1")).toHaveLength(1);
    expect(permissionBroker.resolve("req-1", { behavior: "allow" })).toBe(true);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("forwards PreToolUse without creating a pending permission", async () => {
    const events: AuthenticatedHookEvent[] = [];
    const { registry, permissionBroker, url } = await createTestServer((event) =>
      events.push(event),
    );
    const credentials = registry.registerSession("s1", "claude");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "PreToolUse",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "pwd" },
          tool_use_id: "toolu-1",
        },
      }),
    });

    expect(response.status).toBe(200);
    // claude CLI 2.1.140 在 PreToolUse 看到 "defer" 会直接结束 turn (stop_reason="tool_deferred",
    // result.result=""), UI 仅收到 assistant_tool_use + turn_result, 无最终 assistant_message。
    // 改 "ask" 让 claude 走 stdio control_request 路径, 由 worker handleControlRequest →
    // approvalStrategy → forwardToRelay → web 审批面板, 跟 hook 观察通道职责剥离。
    await expect(response.json()).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    });
    expect(permissionBroker.listSession("s1")).toHaveLength(0);
    expect(events).toMatchObject([
      {
        sessionId: "s1",
        provider: "claude",
        event: "PreToolUse",
        requestId: "toolu-1",
      },
    ]);
  });

  it("returns empty stdout for neutral Codex PreToolUse hooks", async () => {
    const events: AuthenticatedHookEvent[] = [];
    const { registry, permissionBroker, url } = await createTestServer((event) =>
      events.push(event),
    );
    const credentials = registry.registerSession("s1", "codex");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        provider: credentials.provider,
        marker: credentials.marker,
        event: "PreToolUse",
        payload: {
          tool_name: "shell",
          tool_input: { command: "pwd" },
          tool_use_id: "call-1",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(permissionBroker.listSession("s1")).toHaveLength(0);
    expect(events).toMatchObject([
      {
        sessionId: "s1",
        provider: "codex",
        event: "PreToolUse",
        requestId: "call-1",
      },
    ]);
  });

  it("returns empty stdout for neutral Claude lifecycle hooks", async () => {
    const events: AuthenticatedHookEvent[] = [];
    const { registry, url } = await createTestServer((event) => events.push(event));
    const credentials = registry.registerSession("s1", "claude");

    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: credentials.sessionId,
          provider: credentials.provider,
          marker: credentials.marker,
          event,
          payload: { hook_event_name: event },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("");
    }

    expect(events.map((event) => event.event)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
  });
});
