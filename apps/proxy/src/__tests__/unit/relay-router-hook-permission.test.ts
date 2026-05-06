import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { ToolApprovalManager } from "#src/serve/tool-approval-manager.js";
import type { WorkerRegistry } from "#src/serve/worker-registry.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

describe("RelayRouter hook permission decisions", () => {
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

    const router = new RelayRouter({
      sessionManager: { getSession: () => undefined } as never,
      workerRegistry: { send: workerSend } as unknown as WorkerRegistry,
      toolApprovalManager: new ToolApprovalManager(),
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
      permissionBroker,
      hookEventRouter: {
        onPermissionResolved: hookResolved,
      } as never,
    });

    router.handle({
      type: "tool_approve",
      sessionId: "s1",
      payload: { toolId: "req-1" },
    });

    await expect(decisionPromise).resolves.toEqual({ behavior: "allow" });
    expect(workerSend).not.toHaveBeenCalled();
    expect(hookResolved).toHaveBeenCalledWith("s1", "req-1", "allow");
  });
});
