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
    sent?: string[];
  }): RelayRouter {
    return new RelayRouter({
      sessionManager: { getSession: () => undefined } as never,
      workerRegistry: { send: options.workerSend } as unknown as WorkerRegistry,
      controlHandlers: {} as never,
      relayConnection: Object.assign(new EventEmitter(), {
        sendRaw: () => {},
      }) as unknown as RelayConnection,
      relaySend: (data) => options.sent?.push(data),
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
    const permissionBroker = new PermissionBroker();
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
    const permissionBroker = new PermissionBroker();
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
    const permissionBroker = new PermissionBroker();
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

  it("records permission request delivery acknowledgements", async () => {
    const permissionBroker = new PermissionBroker();
    const workerSend = vi.fn();
    const hookResolved = vi.fn();
    const decisionPromise = permissionBroker.request({
      requestId: "req-delivered",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: {},
    });
    const router = createRouter({ permissionBroker, workerSend, hookResolved });

    router.handle({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-delivered",
    });

    expect(permissionBroker.get("req-delivered")?.deliveredAt).toBeTypeOf("number");
    expect(permissionBroker.resolve("req-delivered", { behavior: "deny" })).toBe(true);
    await expect(decisionPromise).resolves.toEqual({ behavior: "deny" });
  });

  it("pushes permission decision result after resolving approval", async () => {
    const permissionBroker = new PermissionBroker();
    const workerSend = vi.fn();
    const hookResolved = vi.fn();
    const sent: string[] = [];
    const decisionPromise = permissionBroker.request({
      requestId: "req-result",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: {},
    });
    const router = createRouter({ permissionBroker, workerSend, hookResolved, sent });

    router.handle({
      type: "tool_approve",
      sessionId: "s1",
      payload: { toolId: "req-result" },
    });

    await expect(decisionPromise).resolves.toEqual({ behavior: "allow" });
    expect(sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "permission_decision_result",
      sessionId: "s1",
      requestId: "req-result",
      outcome: "allow",
      delivered: true,
    });
  });
});
