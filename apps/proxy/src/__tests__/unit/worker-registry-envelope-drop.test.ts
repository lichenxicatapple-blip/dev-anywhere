import { describe, it, expect, beforeEach } from "vitest";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

const buildToolUseRequestRaw = (sessionId: string, toolId: string): string =>
  JSON.stringify({
    version: 1,
    type: "tool_use_request",
    sessionId,
    seq: 1,
    payload: { toolName: "Bash", toolId, parameters: { command: "ls" } },
    source: "proxy",
    timestamp: Date.now(),
  });

describe("WorkerRegistry onEnvelopeDropped", () => {
  let relay: RelayConnection;
  let permissionBroker: PermissionBroker;
  let registry: WorkerRegistry;

  beforeEach(() => {
    relay = createRelayConnectionFake().relayConnection;
    permissionBroker = new PermissionBroker();
    registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake(),
      permissionBroker,
      relayConnection: relay,
      jsonObserver: createJsonObserverFake(),
    });
    // 引用以避免 lint unused
    void registry;
  });

  it("clears pending approval when queue drops a tool_use_request envelope", () => {
    const decisions: unknown[] = [];
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-1",
        sessionId: "s1",
        provider: "claude",
        toolName: "Bash",
        input: { command: "ls" },
      },
      (decision) => decisions.push(decision),
    );
    expect(permissionBroker.listSession("s1")).toHaveLength(1);

    relay.emit("envelope_dropped", buildToolUseRequestRaw("s1", "req-1"));

    expect(permissionBroker.listSession("s1")).toHaveLength(0);
    expect(decisions).toEqual([
      {
        behavior: "deny",
        message: "Approval request was dropped due to relay queue overflow.",
      },
    ]);
  });

  it("leaves pending untouched for non tool_use_request envelopes", () => {
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-2",
        sessionId: "s2",
        provider: "claude",
        toolName: "Write",
        input: { path: "/tmp/a" },
      },
      () => {},
    );
    const assistantMessage = JSON.stringify({
      version: 1,
      type: "assistant_message",
      sessionId: "s2",
      seq: 1,
      payload: { text: "hi", isPartial: false },
      source: "proxy",
      timestamp: Date.now(),
    });
    relay.emit("envelope_dropped", assistantMessage);

    expect(permissionBroker.listSession("s2")).toHaveLength(1);
  });

  it("silently ignores invalid JSON", () => {
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-3",
        sessionId: "s3",
        provider: "claude",
        toolName: "Read",
        input: { path: "/tmp/b" },
      },
      () => {},
    );
    expect(() => relay.emit("envelope_dropped", "not json {{{")).not.toThrow();
    expect(permissionBroker.listSession("s3")).toHaveLength(1);
  });

  it("is a no-op when toolId has no matching pending entry", () => {
    expect(() =>
      relay.emit("envelope_dropped", buildToolUseRequestRaw("s4", "unknown-req")),
    ).not.toThrow();
  });
});
