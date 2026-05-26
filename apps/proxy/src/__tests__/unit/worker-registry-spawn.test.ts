import { describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

const spawnScriptMock = vi.hoisted(() =>
  vi.fn((_entry: string, _args: string[], _options?: unknown) => ({
    pid: 4321,
  })),
);

vi.mock("#src/common/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/common/env.js")>();
  return {
    ...actual,
    spawnScript: spawnScriptMock,
  };
});

describe("WorkerRegistry spawn", () => {
  it("launches the JSON worker process with the requested permission mode", () => {
    const relay = createRelayConnectionFake();
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake(),
      permissionBroker: new PermissionBroker(),
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({ CLAUDE_BIN: "claude" }),
    });

    const pid = registry.spawn("s1", {
      cwd: "/tmp/project",
      permissionMode: "plan",
      hook: {
        provider: "claude",
        sessionId: "s1",
        hookUrl: "http://127.0.0.1:1/hook",
        marker: "marker-1",
        token: "token-1",
      },
    });

    expect(pid).toBe(4321);
    expect(spawnScriptMock).toHaveBeenCalledTimes(1);
    expect(spawnScriptMock.mock.calls[0][0]).toBe("session-worker");
    expect(spawnScriptMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["--cwd", "/tmp/project", "--permission-mode", "plan"]),
    );
    expect(spawnScriptMock.mock.calls[0][2]).toMatchObject({
      env: {
        CLAUDE_BIN: "claude",
        DEV_ANYWHERE_HOOK_TOKEN: "token-1",
      },
    });
  });

  it("passes the requested provider to the JSON worker process", () => {
    const relay = createRelayConnectionFake();
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake(),
      permissionBroker: new PermissionBroker(),
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({ CODEX_BIN: "codex" }),
    });

    registry.spawn("s1", {
      cwd: "/tmp/project",
      provider: "codex",
    });

    expect(spawnScriptMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(["--provider", "codex"]),
    );
  });
});
