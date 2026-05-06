import { afterEach, describe, expect, it } from "vitest";
import { HookRegistry } from "#src/serve/hook-registry.js";
import { HookServer, type AuthenticatedHookEvent } from "#src/serve/hook-server.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";

const servers: HookServer[] = [];

async function createTestServer(onEvent?: (event: AuthenticatedHookEvent) => void) {
  const registry = new HookRegistry();
  const permissionBroker = new PermissionBroker(1000);
  const server = new HookServer({
    port: 0,
    registry,
    permissionBroker,
    onEvent,
  });
  await server.start();
  servers.push(server);
  const port = server.getListeningPort();
  if (!port) throw new Error("Hook test server did not expose a port");
  return { registry, permissionBroker, url: `http://127.0.0.1:${port}/hook` };
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

    await expect(response.json()).resolves.toEqual({ ok: true });
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(permissionBroker.listSession("s1")).toHaveLength(1);
    expect(permissionBroker.resolve("req-1", { behavior: "allow" })).toBe(true);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ behavior: "allow" });
  });
});
