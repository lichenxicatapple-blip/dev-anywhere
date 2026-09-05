import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { createProviderHookRuntime } from "#src/serve/provider-hook-runtime.js";
import { createRelayConnectionFake, createSessionManagerFake } from "./test-fakes.js";

const paths = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "provider-hook-runtime-"));
  return { root, registryPath: join(root, "hooks.json") };
});

vi.mock("#src/common/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/common/paths.js")>()),
  HOOK_REGISTRY_PATH: paths.registryPath,
}));

const runtimes: Array<Awaited<ReturnType<typeof createProviderHookRuntime>>> = [];

beforeEach(() => mkdirSync(paths.root, { recursive: true }));
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.hookServer.close()));
  rmSync(paths.root, { recursive: true, force: true });
});

describe("terminal hook credentials across Proxy reconnects", () => {
  it.each(["claude", "codex"] as const)(
    "keeps a live %s CLI's original credentials valid after restoring the HookRegistry",
    async (provider) => {
      const sessionManager = createSessionManagerFake([
        {
          id: "hosted-agent",
          kind: "agent",
          mode: "pty",
          provider,
          ptyOwner: "proxy-hosted",
          cwd: paths.root,
          pid: 123,
          state: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
      sessionManager.getRuntimeSession = sessionManager.getSession;
      const agentStatusRegistry = new AgentStatusRegistry();
      const options = {
        permissionBroker: new PermissionBroker(),
        sessionManager,
        relayConnection: createRelayConnectionFake().relayConnection,
        agentStatusRegistry,
        changeSessionState: vi.fn(() => true),
      };
      const original = await createProviderHookRuntime({ ...options, hookPort: 0 });
      runtimes.push(original);
      const credentials = original.createHookContext("hosted-agent", provider);
      const persisted = readFileSync(paths.registryPath, "utf8");
      expect(original.createTerminalHookContext("hosted-agent", provider)).toBeUndefined();
      expect(original.hookRegistry.verify(credentials)).not.toBeNull();
      const port = original.hookServer.getListeningPort();
      expect(port).toBeGreaterThan(0);
      await original.hookServer.close();

      const replacement = await createProviderHookRuntime({ ...options, hookPort: port! });
      runtimes.push(replacement);
      expect(replacement.createTerminalHookContext("hosted-agent", provider)).toBeUndefined();
      expect(replacement.hookRegistry.verify(credentials)).not.toBeNull();
      expect(readFileSync(paths.registryPath, "utf8")).toBe(persisted);

      const response = await fetch(credentials.hookUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: credentials.sessionId,
          provider,
          marker: credentials.marker,
          event: "SessionStart",
          payload: {},
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(agentStatusRegistry.get("hosted-agent")).toMatchObject({ provider, phase: "idle" });
    },
  );
});
