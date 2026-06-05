import { describe, expect, it, vi } from "vitest";
import { RelayControlSchema, SessionState } from "@dev-anywhere/shared";
import { RelayRouter } from "#src/serve/relay-router.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { AgentStatusRegistry } from "#src/serve/agent-status-registry.js";
import { createRelayConnectionFake, createWorkerRegistryFake } from "./test-fakes.js";

describe("RelayRouter agent_status_request", () => {
  function createRemoteFileStreamManagerFake() {
    return { start: vi.fn(), cancel: vi.fn() } as never;
  }

  function createRemoteFileUploadManagerFake() {
    return { start: vi.fn(), complete: vi.fn(), cancel: vi.fn(), handleBinary: vi.fn() } as never;
  }

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
      terminalWorkerSpawner: {} as never,
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
      getProviderEnv: () => ({}),
      getAgentCliSuggestions: () => ({}),
      setAgentCliPath: () => {},
      remoteFileStreamManager: createRemoteFileStreamManagerFake(),
      remoteFileUploadManager: createRemoteFileUploadManagerFake(),
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

  it("answers synthetic latency probes without touching session state", () => {
    const registry = new AgentStatusRegistry();
    const sent: string[] = [];
    const router = createRouter({
      registry,
      relaySend: (data) => sent.push(data),
      activeSessions: new Set(),
    });

    router.handle({ type: "latency_web_proxy_ping", requestId: "latency-web-proxy-1" });
    router.handle({ type: "latency_relay_proxy_ping", requestId: "latency-relay-proxy-1" });

    expect(sent).toHaveLength(2);
    const webProxy = RelayControlSchema.parse(JSON.parse(sent[0]));
    const relayProxy = RelayControlSchema.parse(JSON.parse(sent[1]));
    expect(webProxy).toMatchObject({
      type: "latency_web_proxy_pong",
      requestId: "latency-web-proxy-1",
    });
    expect(relayProxy).toMatchObject({
      type: "latency_relay_proxy_pong",
      requestId: "latency-relay-proxy-1",
    });
  });
});
