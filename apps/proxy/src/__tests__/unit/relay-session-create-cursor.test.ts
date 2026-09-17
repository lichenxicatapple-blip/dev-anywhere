import { describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { CURSOR_JSON_UNSUPPORTED_MESSAGE } from "#src/providers/cursor.js";
import { RelaySessionCreateHandler } from "#src/serve/relay-session-create-handler.js";
import type { SessionManager } from "#src/serve/session-manager.js";

vi.mock("#src/common/pty-runtime.js", () => ({
  buildHostedPtyArgs: () => [],
}));

describe("Cursor session create", () => {
  it("rejects JSON sessions for Cursor CLI", () => {
    const relaySend = vi.fn();
    const start = vi.fn();
    const handler = new RelaySessionCreateHandler({
      relaySend,
      terminalWorkerSpawner: { start } as never,
      sessionManager: { createSession: vi.fn() } as unknown as SessionManager,
      workerRegistry: { spawn: vi.fn() } as never,
      controlHandlers: {} as never,
      permissionBroker: {} as never,
      agentStatusRegistry: {} as never,
      getProviderEnv: () => ({}),
      createHookContext: vi.fn(),
      cleanupHookContext: vi.fn(),
      broadcastSessionSync: vi.fn(),
      broadcastSessionList: vi.fn(),
    });

    handler.onSessionCreate({
      type: "session_create",
      requestId: "cursor-json",
      kind: "agent",
      mode: "json",
      provider: "cursor",
      cwd: "/tmp/project",
      permissionMode: "default",
    });

    expect(start).not.toHaveBeenCalled();
    expect(relaySend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(relaySend.mock.calls[0][0] as string) as {
      success: boolean;
      errorCode: string;
      error: string;
    };
    expect(payload).toMatchObject({
      success: false,
      errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
      error: CURSOR_JSON_UNSUPPORTED_MESSAGE,
    });
  });
});
