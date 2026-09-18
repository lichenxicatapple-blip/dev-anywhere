import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import { RelaySessionCreateHandler } from "#src/serve/relay-session-create-handler.js";
import type { SessionManager } from "#src/serve/session-manager.js";

const existingCwd = tmpdir();

vi.mock("#src/common/pty-runtime.js", () => ({
  buildHostedPtyArgs: () => [],
}));

describe("Cursor session create", () => {
  it("starts a JSON worker for Cursor ACP chat", () => {
    const relaySend = vi.fn();
    const spawn = vi.fn(() => 4321);
    const handler = new RelaySessionCreateHandler({
      relaySend,
      terminalWorkerSpawner: { start: vi.fn() } as never,
      sessionManager: { createSession: vi.fn(), listSessions: vi.fn(() => []) } as unknown as SessionManager,
      workerRegistry: { spawn } as never,
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
      cwd: existingCwd,
      permissionMode: "default",
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: existingCwd,
        provider: "cursor",
        permissionMode: "default",
      }),
    );
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("rejects unsupported Cursor permission modes", () => {
    const relaySend = vi.fn();
    const spawn = vi.fn();
    const handler = new RelaySessionCreateHandler({
      relaySend,
      terminalWorkerSpawner: { start: vi.fn() } as never,
      sessionManager: { createSession: vi.fn(), listSessions: vi.fn(() => []) } as unknown as SessionManager,
      workerRegistry: { spawn } as never,
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
      requestId: "cursor-bad-mode",
      kind: "agent",
      mode: "json",
      provider: "cursor",
      cwd: existingCwd,
      permissionMode: "acceptEdits",
    });

    expect(spawn).not.toHaveBeenCalled();
    const payload = JSON.parse(relaySend.mock.calls[0][0] as string) as {
      success: boolean;
      errorCode: string;
    };
    expect(payload).toMatchObject({
      success: false,
      errorCode: ControlErrorCode.APPROVAL_POLICY_UNSUPPORTED,
    });
  });
});
