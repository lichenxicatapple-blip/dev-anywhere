import { Duplex, PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import {
  encodeBinaryIpcFrame,
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
} from "#src/ipc/ipc-protocol.js";
import { handleTerminalConnection } from "#src/serve/terminal-ipc.js";
import { SessionManager, type SessionInfo } from "#src/serve/session-manager.js";

describe("local terminal IPC state ownership", () => {
  it.each([
    { oldRegistered: false, newRegistered: false },
    { oldRegistered: false, newRegistered: true },
    { oldRegistered: true, newRegistered: false },
    { oldRegistered: true, newRegistered: true },
  ])(
    "does not release a replacement connection on old close (old registered=$oldRegistered, new registered=$newRegistered)",
    async ({ oldRegistered, newRegistered }) => {
      const dir = mkdtempSync(join(tmpdir(), "terminal-binding-test-"));
      const onSessionRemoved = vi.fn();
      const manager = new SessionManager({
        persistPath: join(dir, "sessions.json"),
        allowSessionRuntimeHandover: { terminal: true, worker: true },
        onSessionRemoved,
      });
      const session = manager.claimPtySession({
        kind: "agent",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp",
        pid: process.pid,
      }).session;
      manager.releasePtyBinding(session.id, process.pid);
      const terminalSockets = new Map<string, Socket>();
      const terminalClaims = new Map<string, Socket>();
      const sendBinary = vi.fn();
      const deps = {
        sessionManager: manager,
        terminalSockets,
        terminalClaims,
        terminalSubscriptionBacklog: { take: () => [], delete: vi.fn() },
        relayConnection: {
          sendRaw: vi.fn(),
          sendBinary,
          sendEnvelope: vi.fn(),
          getStatus: () => ({ connected: true }),
        },
        permissionBroker: { listSession: () => [] },
        hookEventRouter: {},
        createHookContext: () => undefined,
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: () => false,
        resolveInterruptedApprovals: vi.fn(),
      };
      const createSocket = (): Socket => {
        const socket = new Duplex({
          read() {},
          write(_chunk, _encoding, done) {
            done();
          },
        }) as unknown as Socket;
        handleTerminalConnection(socket, deps as never, {
          clientKind: "terminal-worker",
          sessionId: session.id,
        });
        return socket;
      };
      const oldSocket = createSocket();
      const newSocket = createSocket();
      const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
      const createRequest = serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        kind: "agent",
        mode: "pty",
        provider: "kimi",
        cwd: session.cwd,
        pid: session.pid,
        sessionId: session.id,
      });
      const register = serializeIpc({
        type: "pty_register",
        sessionId: session.id,
        pid: session.pid,
      });
      try {
        oldSocket.push(createRequest);
        await tick();
        if (oldRegistered) {
          oldSocket.push(register);
          await tick();
        }
        newSocket.push(createRequest);
        await tick();
        if (newRegistered) {
          newSocket.push(register);
          await tick();
        }
        // A stale claim (or duplicate registration from an old bound socket) cannot take
        // ownership back from the newer connection, even before the newer one registers.
        oldSocket.push(register);
        await tick();
        expect(terminalClaims.get(session.id)).toBe(newRegistered ? undefined : newSocket);
        if (newRegistered) expect(terminalSockets.get(session.id)).toBe(newSocket);
        oldSocket.destroy();
        await tick();
        expect(manager.getSession(session.id)).toBeDefined();
        expect(onSessionRemoved).not.toHaveBeenCalled();
        if (!newRegistered) {
          newSocket.push(register);
          await tick();
        }
        expect(terminalClaims.has(session.id)).toBe(false);
        expect(terminalSockets.get(session.id)).toBe(newSocket);
        newSocket.push(encodeBinaryIpcFrame(session.id, Buffer.from("still connected"), 1));
        await tick();
        expect(sendBinary).toHaveBeenCalledOnce();
        newSocket.destroy();
        await tick();
        expect(manager.getSession(session.id)).toBeUndefined();
        expect(manager.getRuntimeSession(session.id)).toBeDefined();
        expect(terminalClaims.size).toBe(0);
      } finally {
        oldSocket.destroy();
        newSocket.destroy();
        await tick();
        manager.stopReaper();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "local reconnect cannot change its session id",
      { clientKind: "local-terminal", sessionId: "admitted-session" } as const,
      "different-session",
    ],
    [
      "terminal worker cannot register a different session",
      { clientKind: "terminal-worker", sessionId: "admitted-session" } as const,
      "different-session",
    ],
  ])("rejects an admitted scope mismatch: %s", async (_label, admission, sessionId) => {
    const socket = new PassThrough() as unknown as Socket;
    const end = vi.spyOn(socket, "end");
    const claimPtySession = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: { claimPtySession },
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: {},
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
    expect(claimPtySession).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("registers Kimi local PTY sessions without creating a provider hook", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const createHookContext = vi.fn();
    const claimPtySession = vi.fn(() => ({
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
          releasePtyBinding: vi.fn(),
          getSession: vi.fn(),
          claimPtySession,
          terminateSession: vi.fn(),
        } as never,
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: {},
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

    await vi.waitFor(() => expect(claimPtySession).toHaveBeenCalled());
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
          releasePtyBinding: vi.fn(),
          getSession: vi.fn(() => session),
          claimPtySession: vi.fn(() => ({ session, source: "active" })),
          listSessions: vi.fn(() => [session]),
          updateState,
          touchSession: vi.fn(() => false),
        },
        terminalClaims: new Map(),
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
          releasePtyBinding: vi.fn(),
          getSession: vi.fn(() => session),
          claimPtySession: vi.fn(() => ({ session, source: "active" })),
          listSessions: vi.fn(() => [session]),
        },
        terminalClaims: new Map(),
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
    const claimPtySession = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          releasePtyBinding: vi.fn(),
          getSession: vi.fn(),
          claimPtySession,
        },
        terminalClaims: new Map(),
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
    expect(claimPtySession).not.toHaveBeenCalled();
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
    const claimPtySession = vi.fn(() => ({ session, source: "created" as const }));
    const releasePtyBinding = vi.fn(() => ({ success: true, pid: session.pid }));
    const end = vi.spyOn(socket, "end");

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimPtySession,
          releasePtyBinding,
          getSession: vi.fn(() => session),
        },
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
    expect(claimPtySession).toHaveBeenCalledOnce();
    expect(releasePtyBinding).toHaveBeenCalledOnce();
    expect(releasePtyBinding).toHaveBeenCalledWith(session.id, session.pid);
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
    const claimPtySession = vi.fn(() => {
      throw new TypeError("PTY reconnect session is not available for handover");
    });

    handleTerminalConnection(
      socket,
      {
        sessionManager: { claimPtySession, terminateSession: vi.fn() },
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
    const releasePtyBinding = vi.fn(() => ({ success: true, pid: session.pid }));
    const end = vi.spyOn(socket, "end");

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimPtySession: vi.fn(() => ({ session, source: "created" as const })),
          releasePtyBinding,
        },
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
    expect(releasePtyBinding).toHaveBeenCalledWith(session.id, session.pid);
    expect(JSON.parse(String(end.mock.calls[0]?.[0]).trim())).toMatchObject({
      type: "session_create_response",
      success: false,
      error: "hook setup failed",
    });
    socket.destroy();
  });

  it("returns a half-registered claim to pending without terminating its runtime", async () => {
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
    const releasePtyBinding = vi.fn(() => ({ success: true, pid: session.pid }));

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          claimPtySession: vi.fn(() => ({ session, source: "pending" as const })),
          releasePtyBinding,
        },
        terminalClaims: new Map(),
        terminalSockets: new Map(),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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

    await vi.waitFor(() => expect(releasePtyBinding).toHaveBeenCalledWith(session.id, session.pid));
  });

  it("does not accept reverse-direction mutation messages from a terminal socket", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const terminateSession = vi.fn();
    const updateState = vi.fn();
    const targetWrite = vi.fn();

    handleTerminalConnection(
      socket,
      {
        sessionManager: {
          releasePtyBinding: vi.fn(),
          getSession: vi.fn(() => ({ id: "victim", mode: "pty" })),
          terminateSession,
          updateState,
        },
        terminalClaims: new Map(),
        terminalSockets: new Map([["victim", { writable: true, write: targetWrite } as never]]),
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
        terminalClaims: new Map(),
        terminalSockets,
        terminalSubscriptionBacklog: { take: vi.fn(() => []), delete: vi.fn() },
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
