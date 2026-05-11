import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEventBridge } from "#src/serve/event-bridge.js";
import { SessionManager } from "#src/serve/session-manager.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

function makeSessionManager(): SessionManager {
  return new SessionManager({
    persistPath: join(mkdtempSync(join(tmpdir(), "event-bridge-test-")), "sessions.json"),
  });
}

function makeBridge(opts: {
  controlCleanup?: () => void;
  agentDelete?: () => void;
  permissionCleanup?: () => void;
}) {
  const manager = makeSessionManager();
  const session = manager.createSession("pty", "/tmp/p", process.pid);
  const envelopes: unknown[] = [];
  const relay = {
    sendEnvelope: (envelope: unknown) => envelopes.push(envelope),
    sendRaw: vi.fn(),
  } as unknown as RelayConnection;
  const bridge = createEventBridge({
    sessionManager: manager,
    relayConnection: relay,
    agentStatusRegistry: {
      delete: opts.agentDelete ?? vi.fn(),
    } as never,
    controlHandlers: {
      cleanup: opts.controlCleanup ?? vi.fn(),
    } as never,
    permissionBroker: {
      cleanupSession: opts.permissionCleanup ?? vi.fn(),
    },
  });
  return { manager, bridge, envelopes, sessionId: session.id };
}

describe("cleanupSessionResources isolation", () => {
  // session 残留 + 上传超时复合 bug 的根因测试: 任何中间 cleanup 步骤抛异常,
  // 都不能阻断最后的 broadcastSessionList; 一旦广播没出去, web 不知道 session
  // 已删, 列表残留, 后续给该 session 的请求全部 hang 到超时。
  it("broadcasts session list even when controlHandlers.cleanup throws", () => {
    const { bridge, envelopes, sessionId } = makeBridge({
      controlCleanup: () => {
        throw new Error("control handler boom");
      },
    });

    expect(() => bridge.cleanupSessionResources(sessionId)).not.toThrow();
    expect(envelopes.some((e) => (e as { type: string }).type === "session_list")).toBe(true);
  });

  it("broadcasts session list even when permissionBroker.cleanupSession throws", () => {
    const { bridge, envelopes, sessionId } = makeBridge({
      permissionCleanup: () => {
        throw new Error("permission broker boom");
      },
    });

    expect(() => bridge.cleanupSessionResources(sessionId)).not.toThrow();
    expect(envelopes.some((e) => (e as { type: string }).type === "session_list")).toBe(true);
  });

  it("broadcasts session list even when agentStatusRegistry.delete throws", () => {
    const { bridge, envelopes, sessionId } = makeBridge({
      agentDelete: () => {
        throw new Error("agent registry boom");
      },
    });

    expect(() => bridge.cleanupSessionResources(sessionId)).not.toThrow();
    expect(envelopes.some((e) => (e as { type: string }).type === "session_list")).toBe(true);
  });

  it("runs every cleanup step even if an earlier one throws", () => {
    const calls: string[] = [];
    const controlCleanup = vi.fn(() => {
      calls.push("control");
      throw new Error("boom");
    });
    const agentDelete = vi.fn(() => calls.push("agent"));
    const permissionCleanup = vi.fn(() => calls.push("permission"));
    const { bridge, sessionId } = makeBridge({
      controlCleanup,
      agentDelete,
      permissionCleanup,
    });

    bridge.cleanupSessionResources(sessionId);

    expect(calls).toEqual(["control", "agent", "permission"]);
  });
});
