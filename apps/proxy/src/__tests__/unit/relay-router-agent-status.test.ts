import { describe, expect, it } from "vitest";
import { RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import { createRelayConnectionFake, createWorkerRegistryFake } from "./test-fakes.js";

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
      workerRegistry: createWorkerRegistryFake({ send: () => true }),
      controlHandlers: {} as never,
      relayConnection: createRelayConnectionFake().relayConnection,
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

  it("returns current status snapshot for the requested active session", () => {
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

    router.handle({ type: "agent_status_request", requestId: "req-1", sessionId: "s1" });

    expect(sent).toHaveLength(1);
    const msg = RelayControlSchema.parse(JSON.parse(sent[0]));
    expect(msg.type).toBe("agent_status_response");
    if (msg.type === "agent_status_response") {
      expect(msg.requestId).toBe("req-1");
      expect(msg.statuses).toHaveLength(1);
      expect(msg.statuses[0].sessionId).toBe("s1");
      expect(msg.statuses[0].payload.phase).toBe("waiting_permission");
    }
  });

  it("returns an empty snapshot for removed sessions", () => {
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

    router.handle({ type: "agent_status_request", requestId: "req-2" });

    expect(sent).toHaveLength(1);
    const msg = RelayControlSchema.parse(JSON.parse(sent[0]));
    expect(msg.type).toBe("agent_status_response");
    if (msg.type === "agent_status_response") {
      expect(msg.requestId).toBe("req-2");
      expect(msg.statuses).toEqual([]);
    }
  });
});
