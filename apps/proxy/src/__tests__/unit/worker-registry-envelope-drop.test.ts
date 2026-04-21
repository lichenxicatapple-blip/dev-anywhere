import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { ToolApprovalManager } from "#src/serve/tool-approval-manager.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import type { SessionManager } from "#src/serve/session-manager.js";

// 用 EventEmitter 模拟 RelayConnection 的 on/emit 接口，只测 envelope_dropped 订阅路径
function makeFakeRelay(): EventEmitter & RelayConnection {
  return new EventEmitter() as unknown as EventEmitter & RelayConnection;
}

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
  let relay: EventEmitter & RelayConnection;
  let toolApprovalManager: ToolApprovalManager;
  let registry: WorkerRegistry;

  beforeEach(() => {
    relay = makeFakeRelay();
    toolApprovalManager = new ToolApprovalManager();
    registry = new WorkerRegistry({
      sessionManager: {} as SessionManager,
      toolApprovalManager,
      relayConnection: relay,
      changeSessionState: () => true,
    });
    // 引用以避免 lint unused
    void registry;
  });

  it("clears pending approval when queue drops a tool_use_request envelope", () => {
    toolApprovalManager.register("req-1", {
      sessionId: "s1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    expect(toolApprovalManager.listSession("s1")).toHaveLength(1);

    relay.emit("envelope_dropped", buildToolUseRequestRaw("s1", "req-1"));

    expect(toolApprovalManager.listSession("s1")).toHaveLength(0);
  });

  it("leaves pending untouched for non tool_use_request envelopes", () => {
    toolApprovalManager.register("req-2", {
      sessionId: "s2",
      toolName: "Write",
      input: { path: "/tmp/a" },
    });
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

    expect(toolApprovalManager.listSession("s2")).toHaveLength(1);
  });

  it("silently ignores invalid JSON", () => {
    toolApprovalManager.register("req-3", {
      sessionId: "s3",
      toolName: "Read",
      input: { path: "/tmp/b" },
    });
    expect(() => relay.emit("envelope_dropped", "not json {{{")).not.toThrow();
    expect(toolApprovalManager.listSession("s3")).toHaveLength(1);
  });

  it("is a no-op when toolId has no matching pending entry", () => {
    expect(() =>
      relay.emit("envelope_dropped", buildToolUseRequestRaw("s4", "unknown-req")),
    ).not.toThrow();
  });
});
