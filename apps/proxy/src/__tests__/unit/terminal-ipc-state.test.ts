import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { encodeBinaryIpcFrame, serializeIpc } from "#src/ipc/ipc-protocol.js";
import { handleTerminalConnection } from "#src/serve/terminal-ipc.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

describe("local terminal IPC state ownership", () => {
  it("registers Kimi local PTY sessions without creating a provider hook", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const createHookContext = vi.fn();
    const createSession = vi.fn(() => ({
      id: "kimi-session",
      mode: "pty" as const,
      provider: "kimi" as const,
      ptyOwner: "local-terminal" as const,
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: process.pid,
    }));

    handleTerminalConnection(socket, {
      sessionManager: { getSession: vi.fn(), createSession } as never,
      workerRegistry: {},
      terminalSockets: new Map(),
      terminalSubscriptionBacklog: {},
      hostedPtyRegistry: {},
      relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn() },
      permissionBroker: { listSession: vi.fn(() => []) },
      hookEventRouter: {},
      createHookContext,
      emitAgentStatus: vi.fn(),
      updateTerminalCwd: vi.fn(),
      resolveInterruptedApprovals: vi.fn(),
      config: {},
    } as never);

    socket.write(
      serializeIpc({
        type: "session_create_request",
        mode: "pty",
        provider: "kimi",
        cwd: "/tmp",
        pid: process.pid,
      }),
    );

    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createHookContext).not.toHaveBeenCalled();
    socket.destroy();
  });

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

  it("forwards the local terminal resize render sequence unchanged", async () => {
    const session: SessionInfo = {
      id: "session-1",
      mode: "pty",
      provider: "kimi",
      ptyOwner: "local-terminal",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: process.pid,
    };
    const relayConnection = {
      sendRaw: vi.fn(),
      sendBinary: vi.fn(),
    };
    const socket = new PassThrough() as unknown as Socket;

    handleTerminalConnection(socket, {
      sessionManager: { getSession: vi.fn(() => session) },
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
        type: "pty_resize",
        sessionId: session.id,
        cols: 100,
        rows: 30,
        outputSeq: 17,
      }),
    );

    await vi.waitFor(() => expect(relayConnection.sendRaw).toHaveBeenCalledOnce());
    expect(JSON.parse(relayConnection.sendRaw.mock.calls[0][0])).toEqual({
      type: "terminal_resize",
      sessionId: session.id,
      cols: 100,
      rows: 30,
      outputSeq: 17,
    });
    socket.destroy();
  });
});
