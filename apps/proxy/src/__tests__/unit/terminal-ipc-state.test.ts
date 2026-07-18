import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { encodeBinaryIpcFrame, serializeIpc } from "#src/ipc/ipc-protocol.js";
import { handleTerminalConnection } from "#src/serve/terminal-ipc.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

describe("local terminal IPC state ownership", () => {
  it("keeps a completed turn idle when the terminal emits a redraw frame", async () => {
    const session: SessionInfo = {
      id: "session-1",
      mode: "pty" as const,
      provider: "codex" as const,
      ptyOwner: "local-terminal" as const,
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: process.pid,
    };
    const updateState = vi.fn((_sessionId: string, next: SessionState) => {
      session.state = next;
      return true;
    });
    const relayConnection = {
      sendRaw: vi.fn(),
      sendBinary: vi.fn(),
    };
    const socket = new PassThrough() as unknown as Socket;

    handleTerminalConnection(socket, {
      sessionManager: {
        getSession: vi.fn(() => session),
        updateState,
        touchSession: vi.fn(() => false),
      },
      workerRegistry: {},
      terminalSockets: new Map(),
      terminalSubscriptionBacklog: {},
      hostedPtyRegistry: {},
      relayConnection,
      permissionBroker: { listSession: vi.fn(() => []) },
      hookEventRouter: {},
      createHookContext: vi.fn(),
      emitAgentStatus: vi.fn(),
      updateTerminalCwd: vi.fn(),
      resolveInterruptedApprovals: vi.fn(),
      config: {},
    } as never);

    socket.write(
      serializeIpc({
        type: "pty_semantic_event",
        sessionId: session.id,
        state: "working",
        seq: 1,
      }),
    );
    socket.write(
      serializeIpc({
        type: "pty_semantic_event",
        sessionId: session.id,
        state: "turn_complete",
        seq: 2,
      }),
    );

    await vi.waitFor(() => expect(session.state).toBe(SessionState.IDLE));
    updateState.mockClear();

    socket.write(encodeBinaryIpcFrame(session.id, Buffer.from("\u001b[?25h"), 3));

    await vi.waitFor(() => expect(relayConnection.sendBinary).toHaveBeenCalledOnce());
    expect(session.state).toBe(SessionState.IDLE);
    expect(updateState).not.toHaveBeenCalled();
    socket.destroy();
  });
});
