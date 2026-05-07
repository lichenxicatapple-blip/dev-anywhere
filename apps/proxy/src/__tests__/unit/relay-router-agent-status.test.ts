import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import type { WorkerRegistry } from "#src/serve/worker-registry.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

describe("RelayRouter agent_status_request", () => {
  function createRouter(options: {
    registry: AgentStatusRegistry;
    relaySend: (data: string) => void;
    activeSessions: Set<string>;
  }): RelayRouter {
    return new RelayRouter({
      sessionManager: {
        getSession: (sessionId: string) =>
          options.activeSessions.has(sessionId)
            ? {
                id: sessionId,
                mode: "json",
                provider: "claude",
                state: SessionState.WORKING,
                cwd: "/tmp",
                pid: 1,
              }
            : undefined,
      } as never,
      workerRegistry: { send: () => true } as unknown as WorkerRegistry,
      controlHandlers: {} as never,
      relayConnection: Object.assign(new EventEmitter(), {
        sendRaw: () => {},
      }) as unknown as RelayConnection,
      relaySend: options.relaySend,
      terminalSockets: new Map(),
      hostedPtyRegistry: {} as never,
      broadcastSessionList: () => {},
      broadcastSessionSync: () => {},
      jsonObserver: {} as never,
      createHookContext: () => {
        throw new Error("not used");
      },
      cleanupHookContext: () => {},
      permissionBroker: new PermissionBroker(),
      hookEventRouter: {} as never,
      agentStatusRegistry: options.registry,
    });
  }

  it("pushes current status for the requested active session", () => {
    const registry = new AgentStatusRegistry();
    registry.set("s1", {
      provider: "claude",
      phase: "waiting_permission",
      seq: 2,
      updatedAt: 1760000000000,
    });
    const sent: string[] = [];
    const router = createRouter({
      registry,
      relaySend: (data) => sent.push(data),
      activeSessions: new Set(["s1"]),
    });

    router.handle({ type: "agent_status_request", sessionId: "s1" });

    expect(sent).toHaveLength(1);
    const msg = RelayControlSchema.parse(JSON.parse(sent[0]));
    expect(msg.type).toBe("agent_status");
    if (msg.type === "agent_status") {
      expect(msg.sessionId).toBe("s1");
      expect(msg.payload.phase).toBe("waiting_permission");
    }
  });

  it("does not replay stale status for removed sessions", () => {
    const registry = new AgentStatusRegistry();
    registry.set("removed", {
      provider: "codex",
      phase: "thinking",
      seq: 1,
      updatedAt: 1760000000000,
    });
    const sent: string[] = [];
    const router = createRouter({
      registry,
      relaySend: (data) => sent.push(data),
      activeSessions: new Set(),
    });

    router.handle({ type: "agent_status_request" });

    expect(sent).toEqual([]);
  });
});
