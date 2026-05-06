import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import type { WorkerRegistry } from "#src/serve/worker-registry.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

describe("RelayRouter hook permission decisions", () => {
  function createRouter(options: {
    permissionBroker: PermissionBroker;
    workerSend: ReturnType<typeof vi.fn>;
    hookResolved: ReturnType<typeof vi.fn>;
  }): RelayRouter {
    return new RelayRouter({
      sessionManager: { getSession: () => undefined } as never,
      workerRegistry: { send: options.workerSend } as unknown as WorkerRegistry,
      controlHandlers: {} as never,
      relayConnection: Object.assign(new EventEmitter(), {
        sendRaw: () => {},
      }) as unknown as RelayConnection,
      relaySend: () => {},
      terminalSockets: new Map(),
      broadcastSessionList: () => {},
      broadcastSessionSync: () => {},
      jsonObserver: {} as never,
      createHookContext: () => {
        throw new Error("not used");
      },
      permissionBroker: options.permissionBroker,
      hookEventRouter: {
        onPermissionResolved: options.hookResolved,
      } as never,
      agentStatusRegistry: new AgentStatusRegistry(),
    });
  }

  it("resolves hook PermissionRequest before falling back to worker approval path", async () => {
    const permissionBroker = new PermissionBroker(1000);
    const workerSend = vi.fn();
    const hookResolved = vi.fn();
    const decisionPromise = permissionBroker.request({
      requestId: "req-1",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: { command: "pwd" },
    });

    const router = createRouter({ permissionBroker, workerSend, hookResolved });

    router.handle({
      type: "tool_approve",
      sessionId: "s1",
      payload: { toolId: "req-1" },
    });

    await expect(decisionPromise).resolves.toEqual({ behavior: "allow" });
    expect(workerSend).not.toHaveBeenCalled();
    expect(hookResolved).toHaveBeenCalledWith("s1", "claude", "req-1", "allow", {
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });
  });

  it("denies hook permission requests and clears the pending broker entry", async () => {
    const permissionBroker = new PermissionBroker(1000);
    const workerSend = vi.fn();
    const hookResolved = vi.fn();
    const decisionPromise = permissionBroker.request({
      requestId: "req-1",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: { command: "pwd" },
    });
    const router = createRouter({ permissionBroker, workerSend, hookResolved });

    router.handle({
      type: "tool_deny",
      sessionId: "s1",
      payload: { toolId: "req-1", reason: "No." },
    });

    await expect(decisionPromise).resolves.toEqual({ behavior: "deny", message: "No." });
    expect(permissionBroker.get("req-1")).toBeNull();
    expect(permissionBroker.listSession("s1")).toHaveLength(0);
    expect(workerSend).not.toHaveBeenCalled();
    expect(hookResolved).toHaveBeenCalledWith("s1", "claude", "req-1", "deny", {
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });
  });

  it("resolves worker approval requests through the same broker path", () => {
    const permissionBroker = new PermissionBroker(1000);
    const workerSend = vi.fn();
    const hookResolved = vi.fn();
    const decisions: unknown[] = [];
    permissionBroker.registerWorkerRequest(
      {
        requestId: "worker-req-1",
        sessionId: "s1",
        provider: "claude",
        toolName: "Write",
        input: { file_path: "/tmp/a" },
      },
      (decision) => decisions.push(decision),
    );
    const router = createRouter({ permissionBroker, workerSend, hookResolved });

    router.handle({
      type: "tool_approve",
      sessionId: "s1",
      payload: { toolId: "worker-req-1" },
    });

    expect(decisions).toEqual([{ behavior: "allow" }]);
    expect(permissionBroker.get("worker-req-1")).toBeNull();
    expect(hookResolved).toHaveBeenCalledWith("s1", "claude", "worker-req-1", "allow", {
      toolName: "Write",
      toolInput: { file_path: "/tmp/a" },
    });
  });
});
