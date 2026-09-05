import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import {
  encodeBinaryIpcFrame,
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
} from "#src/ipc/ipc-protocol.js";
import { handleTerminalConnection } from "#src/serve/terminal-ipc.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

describe("local terminal IPC state ownership", () => {
  it.each([
    [
      "local reconnect cannot change its session id",
      { clientKind: "local-terminal", sessionId: "admitted-session" } as const,
      "different-session",
    ],
    [
      "terminal worker cannot register as an agent",
      { clientKind: "terminal-worker", sessionId: "admitted-session" } as const,
      "admitted-session",
    ],
  ])("rejects an admitted scope mismatch: %s", async (_label, admission, sessionId) => {
    const socket = new PassThrough() as unknown as Socket;
    const end = vi.spyOn(socket, "end");
    const claimLocalPtySession = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: { claimLocalPtySession },
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: {},
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn() },
        permissionBroker: {},
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      admission,
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "claude",
        cwd: "/tmp",
        pid: process.pid,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
    );

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(JSON.parse(String(end.mock.calls[0]?.[0]).trim())).toMatchObject({
      type: "session_create_response",
      success: false,
    });
    expect(claimLocalPtySession).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("registers Kimi local PTY sessions without creating a provider hook", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const createHookContext = vi.fn();
    const claimLocalPtySession = vi.fn(() => ({
      source: "created" as const,
      session: {
        id: "kimi-session",
        kind: "agent" as const,
        mode: "pty" as const,
        provider: "kimi" as const,
        ptyOwner: "local-terminal" as const,
        state: SessionState.IDLE,
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp",
        pid: process.pid,
      },
    }));

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          getSession: vi.fn(),
          claimLocalPtySession,
          terminateSession: vi.fn(),
        } as never,
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
      } as never,
      { clientKind: "local-terminal" },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "kimi",
        cwd: "/tmp",
        pid: process.pid,
      }),
    );

    await vi.waitFor(() => expect(claimLocalPtySession).toHaveBeenCalled());
    expect(createHookContext).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("keeps a completed turn idle when the terminal emits a redraw frame", async () => {
    const session: SessionInfo = {
      id: "session-1",
      kind: "agent",
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
      sendEnvelope: vi.fn(),
      getStatus: vi.fn(() => ({ connected: true })),
    };
    const socket = new PassThrough() as unknown as Socket;
    const terminalSockets = new Map<string, Socket>();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          getSession: vi.fn(() => session),
          claimLocalPtySession: vi.fn(() => ({ session, source: "active" })),
          listSessions: vi.fn(() => [session]),
          updateState,
          touchSession: vi.fn(() => false),
        },
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection,
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal", sessionId: session.id },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: session.provider,
        cwd: session.cwd,
        pid: session.pid,
        sessionId: session.id,
      }),
    );
    socket.write(serializeIpc({ type: "pty_register", sessionId: session.id, pid: session.pid }));
    await vi.waitFor(() => expect(terminalSockets.get(session.id)).toBe(socket));

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
      kind: "agent",
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
      sendEnvelope: vi.fn(),
      getStatus: vi.fn(() => ({ connected: true })),
    };
    const socket = new PassThrough() as unknown as Socket;
    const terminalSockets = new Map<string, Socket>();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          getSession: vi.fn(() => session),
          claimLocalPtySession: vi.fn(() => ({ session, source: "active" })),
          listSessions: vi.fn(() => [session]),
        },
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection,
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal", sessionId: session.id },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: session.provider,
        cwd: session.cwd,
        pid: session.pid,
        sessionId: session.id,
      }),
    );
    socket.write(serializeIpc({ type: "pty_register", sessionId: session.id, pid: session.pid }));
    await vi.waitFor(() => expect(terminalSockets.get(session.id)).toBe(socket));
    relayConnection.sendRaw.mockClear();

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

  it.each([
    ["missing", undefined],
    ["mismatched", TERMINAL_IPC_PROTOCOL_VERSION + 1],
  ])("rejects PTY registration when the create protocol version is %s", async (_label, version) => {
    const socket = new PassThrough() as unknown as Socket;
    const terminalSockets = new Map<string, Socket>();
    const claimLocalPtySession = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          getSession: vi.fn(),
          claimLocalPtySession,
        },
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal", sessionId: "unversioned-session" },
    );

    socket.write(
      `${JSON.stringify({
        type: "session_create_request",
        ...(version !== undefined ? { protocolVersion: version } : {}),
        kind: "agent",
        mode: "pty",
        provider: "claude",
        cwd: "/tmp",
        pid: 4242,
        sessionId: "unversioned-session",
      })}\n`,
    );
    socket.write(
      serializeIpc({ type: "pty_register", sessionId: "unversioned-session", pid: 4242 }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(claimLocalPtySession).not.toHaveBeenCalled();
    expect(terminalSockets.size).toBe(0);
    socket.destroy();
  });

  it("rejects a second create handshake on the same socket and rolls back an unpublished session", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const session: SessionInfo = {
      id: "new-session",
      kind: "agent",
      mode: "pty",
      provider: "claude",
      ptyOwner: "local-terminal",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: 4242,
    };
    const claimLocalPtySession = vi.fn(() => ({ session, source: "created" as const }));
    const terminateSession = vi.fn(() => ({ success: true, pid: session.pid }));
    const end = vi.spyOn(socket, "end");

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimLocalPtySession,
          terminateSession,
          getSession: vi.fn(() => session),
        },
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal" },
    );

    const request = serializeIpc({
      type: "session_create_request",
      protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      kind: "agent",
      mode: "pty",
      provider: "claude",
      cwd: session.cwd,
      pid: session.pid,
    });
    socket.write(request);
    socket.write(request);

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(claimLocalPtySession).toHaveBeenCalledOnce();
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(terminateSession).toHaveBeenCalledWith(session.id);
    expect(JSON.parse(String(end.mock.calls[0]?.[0]).trim())).toMatchObject({
      type: "session_create_response",
      success: false,
      error: expect.stringContaining("already used"),
    });
    socket.destroy();
  });

  it("returns a create failure and closes when the session claim is rejected", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const end = vi.spyOn(socket, "end");
    const claimLocalPtySession = vi.fn(() => {
      throw new TypeError("PTY reconnect session is not available for handover");
    });

    handleTerminalConnection(
      socket,
      {
        sessionManager: { claimLocalPtySession, terminateSession: vi.fn() },
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal", sessionId: "unknown-session" },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "claude",
        cwd: "/tmp",
        pid: 4242,
        sessionId: "unknown-session",
      }),
    );

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(JSON.parse(String(end.mock.calls[0]?.[0]).trim())).toMatchObject({
      type: "session_create_response",
      success: false,
      error: "PTY reconnect session is not available for handover",
    });
    socket.destroy();
  });

  it("returns a create failure and rolls back when provider hook setup fails", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const session: SessionInfo = {
      id: "hook-failure-session",
      kind: "agent",
      mode: "pty",
      provider: "claude",
      ptyOwner: "local-terminal",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: 4242,
    };
    const terminateSession = vi.fn(() => ({ success: true, pid: session.pid }));
    const end = vi.spyOn(socket, "end");

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimLocalPtySession: vi.fn(() => ({ session, source: "created" as const })),
          terminateSession,
        },
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(() => {
          throw new Error("hook setup failed");
        }),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal" },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "claude",
        cwd: session.cwd,
        pid: session.pid,
      }),
    );

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    expect(terminateSession).toHaveBeenCalledWith(session.id);
    expect(JSON.parse(String(end.mock.calls[0]?.[0]).trim())).toMatchObject({
      type: "session_create_response",
      success: false,
      error: "hook setup failed",
    });
    socket.destroy();
  });

  it("cleans a materialized pending claim if its socket closes before registration", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const session: SessionInfo = {
      id: "pending-session",
      kind: "agent",
      mode: "pty",
      provider: "kimi",
      ptyOwner: "local-terminal",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: 4242,
    };
    const terminateSession = vi.fn(() => ({ success: true, pid: session.pid }));

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimLocalPtySession: vi.fn(() => ({ session, source: "pending" as const })),
          terminateSession,
        },
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal", sessionId: session.id },
    );

    socket.write(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "kimi",
        cwd: session.cwd,
        pid: session.pid,
        sessionId: session.id,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    socket.destroy();

    await vi.waitFor(() => expect(terminateSession).toHaveBeenCalledWith(session.id));
  });

  it("does not accept reverse-direction mutation messages from a terminal socket", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const terminateSession = vi.fn();
    const updateState = vi.fn();
    const hostedWrite = vi.fn();
    const targetWrite = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          getSession: vi.fn(() => ({ id: "victim", mode: "pty" })),
          terminateSession,
          updateState,
        },
        terminalSockets: new Map([["victim", { writable: true, write: targetWrite } as never]]),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: { write: hostedWrite },
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal" },
    );

    socket.write(`${JSON.stringify({ type: "session_terminate_request", sessionId: "victim" })}\n`);
    socket.write(
      serializeIpc({ type: "pty_input", sessionId: "victim", data: "unexpected input" }),
    );
    socket.write(
      `${JSON.stringify({ type: "session_status_update", sessionId: "victim", state: "working" })}\n`,
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(terminateSession).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
    expect(hostedWrite).not.toHaveBeenCalled();
    expect(targetWrite).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("does not let a different socket deregister an active terminal", async () => {
    const session: SessionInfo = {
      id: "owned-session",
      kind: "agent",
      mode: "pty",
      provider: "claude",
      ptyOwner: "local-terminal",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: 4242,
    };
    const ownerSocket = new PassThrough() as unknown as Socket;
    const unrelatedSocket = new PassThrough() as unknown as Socket;
    const terminalSockets = new Map<string, Socket>([[session.id, ownerSocket]]);
    const terminateSession = vi.fn();

    handleTerminalConnection(
      unrelatedSocket,
      {
        sessionManager: { getSession: vi.fn(() => session), terminateSession },
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
        hostedPtyRegistry: {},
        relayConnection: { sendRaw: vi.fn(), sendBinary: vi.fn(), sendEnvelope: vi.fn() },
        permissionBroker: { listSession: vi.fn(() => []) },
        hookEventRouter: {},
        createHookContext: vi.fn(),
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: vi.fn(),
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      { clientKind: "local-terminal" },
    );

    unrelatedSocket.write(serializeIpc({ type: "pty_deregister", sessionId: session.id }));

    await new Promise((resolve) => setImmediate(resolve));
    expect(terminateSession).not.toHaveBeenCalled();
    expect(terminalSockets.get(session.id)).toBe(ownerSocket);
    unrelatedSocket.destroy();
    ownerSocket.destroy();
  });
});
