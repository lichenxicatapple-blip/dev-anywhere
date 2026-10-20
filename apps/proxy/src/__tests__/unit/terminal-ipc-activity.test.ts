import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeBinaryFrame,
  providerValues,
  ptyOwnerValues,
  SessionState,
  type PtySemanticState,
} from "@dev-anywhere/shared";
import {
  encodeBinaryIpcFrame,
  serializeIpc,
  TERMINAL_IPC_PROTOCOL_VERSION,
} from "#src/ipc/ipc-protocol.js";
import { handleTerminalConnection } from "#src/serve/terminal-ipc.js";
import { SessionManager } from "#src/serve/session-manager.js";

// Captured Codex quota-footer repaint (weekly remaining changed from 80 to 79).
// This fixture contains only terminal controls and the displayed quota number.
const QUOTA_REDRAW = Buffer.from(
  "\x1b[?2026h\x1b[?25l\x1b[27;80H\x1b[38;2;233;144;169;49m79\x1b[39m\x1b[49m\x1b[0m\x1b[25;3H\x1b[?25h\x1b[?2026l",
);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const agentCases = providerValues.flatMap((provider) =>
  ptyOwnerValues.map((ptyOwner) => ({ kind: "agent" as const, provider, ptyOwner })),
);
type HarnessIdentity =
  | (typeof agentCases)[number]
  | { kind: "terminal"; provider: "claude"; ptyOwner: "proxy-hosted" };

describe("terminal IPC activity timestamps", () => {
  let now: number;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  async function connect(identity: HarnessIdentity) {
    const dir = mkdtempSync(join(tmpdir(), "terminal-ipc-activity-"));
    const persistPath = join(dir, "sessions.json");
    const manager = new SessionManager({
      persistPath,
      historyMetadataPath: join(dir, "history.json"),
      allowSessionRuntimeHandover: { terminal: true, worker: true },
    });
    const session = manager.claimPtySession({
      ...identity,
      cwd: dir,
      pid: process.pid,
    }).session;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    }) as unknown as Socket;
    const terminalSockets = new Map<string, Socket>();
    const relay = {
      sendRaw: vi.fn(),
      sendBinary: vi.fn(),
      sendEnvelope: vi.fn(),
      getStatus: () => ({ connected: true }),
    };
    cleanups.push(async () => {
      socket.destroy();
      await tick();
      manager.stopReaper();
      rmSync(dir, { recursive: true, force: true });
    });
    handleTerminalConnection(
      socket,
      {
        sessionManager: manager,
        terminalSockets,
        terminalClaims: new Map(),
        terminalSubscriptionBacklog: { take: () => [], delete: vi.fn() },
        relayConnection: relay,
        permissionBroker: { listSession: () => [] },
        hookEventRouter: {},
        createHookContext: () => undefined,
        emitAgentStatus: vi.fn(),
        updateTerminalCwd: () => false,
        resolveInterruptedApprovals: vi.fn(),
      } as never,
      {
        clientKind: identity.ptyOwner === "local-terminal" ? "local-terminal" : "terminal-worker",
        sessionId: session.id,
      },
    );
    socket.push(
      serializeIpc({
        type: "session_create_request",
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        mode: "pty",
        ...(identity.kind === "terminal"
          ? { kind: "terminal" as const, provider: "claude" as const }
          : { kind: "agent" as const, provider: identity.provider }),
        cwd: session.cwd,
        pid: session.pid,
        sessionId: session.id,
      }),
    );
    socket.push(serializeIpc({ type: "pty_register", sessionId: session.id, pid: session.pid }));
    await tick();
    expect(terminalSockets.get(session.id)).toBe(socket);
    relay.sendEnvelope.mockClear();
    relay.sendRaw.mockClear();

    let sequence = 0;
    return {
      session,
      manager,
      relay,
      persistedUpdatedAt: () =>
        JSON.parse(readFileSync(persistPath, "utf8"))[0].updatedAt as number,
      async output(data: Buffer) {
        const outputSeq = ++sequence;
        socket.push(encodeBinaryIpcFrame(session.id, data, outputSeq));
        await tick();
        const forwarded = decodeBinaryFrame(relay.sendBinary.mock.lastCall![0]);
        expect(forwarded).toEqual({ sessionId: session.id, outputSeq, data: new Uint8Array(data) });
      },
      async semantic(state: PtySemanticState) {
        socket.push(
          serializeIpc({
            type: "pty_semantic_event",
            sessionId: session.id,
            state,
            seq: ++sequence,
          }),
        );
        await tick();
      },
    };
  }

  it.each(agentCases)(
    "preserves idle lastActive while forwarding quota redraws ($provider, $ptyOwner)",
    async (identity) => {
      const h = await connect(identity);
      const idleAt = h.session.updatedAt;

      for (const elapsed of [60_000, 300_000]) {
        now += elapsed;
        await h.output(QUOTA_REDRAW);
        expect(h.session.state).toBe(SessionState.IDLE);
        expect(h.session.updatedAt).toBe(idleAt);
        expect(h.persistedUpdatedAt()).toBe(idleAt);
        expect(h.relay.sendEnvelope).not.toHaveBeenCalled();
      }
      expect(h.relay.sendBinary).toHaveBeenCalledTimes(2);
    },
  );

  it.each(agentCases)(
    "tracks task start, working output and completion without refreshing repeated states ($provider, $ptyOwner)",
    async (identity) => {
      const h = await connect(identity);
      now += 1_000;
      await h.semantic("working");
      const startedAt = now;
      expect(h.session.state).toBe(SessionState.WORKING);
      expect(h.session.updatedAt).toBe(startedAt);
      expect(h.relay.sendEnvelope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "session_status",
          payload: { sessionId: h.session.id, state: SessionState.WORKING, lastActive: startedAt },
        }),
      );
      h.relay.sendEnvelope.mockClear();

      now += 16_000;
      await h.semantic("working");
      expect(h.session.updatedAt).toBe(startedAt);
      expect(h.relay.sendEnvelope).not.toHaveBeenCalled();

      await h.output(Buffer.from("Processing the submitted task\r\n"));
      const outputAt = now;
      expect(h.session.updatedAt).toBe(outputAt);
      expect(h.persistedUpdatedAt()).toBe(outputAt);
      expect(h.relay.sendEnvelope).toHaveBeenCalledOnce();
      expect(h.relay.sendEnvelope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "session_status",
          payload: { sessionId: h.session.id, state: SessionState.WORKING, lastActive: outputAt },
        }),
      );
      h.relay.sendEnvelope.mockClear();

      now += 1_000;
      await h.output(Buffer.from("More task output\r\n"));
      expect(h.session.updatedAt).toBe(outputAt);
      expect(h.relay.sendEnvelope).not.toHaveBeenCalled();

      await h.semantic("turn_complete");
      const completedAt = now;
      expect(h.session.state).toBe(SessionState.IDLE);
      expect(h.session.updatedAt).toBe(completedAt);
      expect(h.persistedUpdatedAt()).toBe(completedAt);
      expect(h.relay.sendEnvelope).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "session_status",
          payload: { sessionId: h.session.id, state: SessionState.IDLE, lastActive: completedAt },
        }),
      );
      h.relay.sendEnvelope.mockClear();

      now += 60_000;
      await h.semantic("turn_complete");
      await h.output(QUOTA_REDRAW);
      expect(h.session.updatedAt).toBe(completedAt);
      expect(h.persistedUpdatedAt()).toBe(completedAt);
      expect(h.relay.sendEnvelope).not.toHaveBeenCalled();
      expect(h.relay.sendBinary).toHaveBeenCalledTimes(3);
    },
  );

  it.each([SessionState.WAITING_APPROVAL, SessionState.ERROR, SessionState.TERMINATED])(
    "forwards remaining output without refreshing a %s agent",
    async (state) => {
      const h = await connect({ kind: "agent", provider: "codex", ptyOwner: "local-terminal" });
      if (state === SessionState.ERROR) {
        // ERROR is not normally reachable by the PTY FSM; exercise a residual frame defensively.
        h.session.state = state;
      } else {
        expect(h.manager.updateState(h.session.id, state)).toBe(true);
      }
      const inactiveAt = h.session.updatedAt;
      now += 60_000;

      await h.output(QUOTA_REDRAW);

      expect(h.session.state).toBe(state);
      expect(h.session.updatedAt).toBe(inactiveAt);
      expect(h.persistedUpdatedAt()).toBe(inactiveAt);
      expect(h.relay.sendEnvelope).not.toHaveBeenCalled();
      expect(h.relay.sendBinary).toHaveBeenCalledOnce();
    },
  );

  it("retains activity updates and throttling for ordinary shell output", async () => {
    const h = await connect({ kind: "terminal", provider: "claude", ptyOwner: "proxy-hosted" });
    now += 60_000;

    await h.output(Buffer.from("shell output\r\n"));
    const outputAt = now;
    expect(h.session.state).toBe(SessionState.IDLE);
    expect(h.session.updatedAt).toBe(outputAt);
    expect(h.persistedUpdatedAt()).toBe(outputAt);
    expect(h.relay.sendEnvelope).toHaveBeenCalledOnce();
    expect(h.relay.sendEnvelope).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "session_status",
        payload: { sessionId: h.session.id, state: SessionState.IDLE, lastActive: outputAt },
      }),
    );

    now += 1_000;
    await h.output(Buffer.from("more shell output\r\n"));
    expect(h.session.updatedAt).toBe(outputAt);
    expect(h.relay.sendEnvelope).toHaveBeenCalledOnce();
    expect(h.relay.sendBinary).toHaveBeenCalledTimes(2);
  });

  it.each<HarnessIdentity>([
    { kind: "agent", provider: "codex", ptyOwner: "proxy-hosted" },
    { kind: "terminal", provider: "claude", ptyOwner: "proxy-hosted" },
  ])("does not count an empty output frame as activity for $kind sessions", async (identity) => {
    const h = await connect(identity);
    if (identity.kind === "agent") await h.semantic("working");
    h.relay.sendEnvelope.mockClear();
    const activeAt = h.session.updatedAt;
    now += 60_000;

    await h.output(Buffer.alloc(0));

    expect(h.session.updatedAt).toBe(activeAt);
    expect(h.persistedUpdatedAt()).toBe(activeAt);
    expect(h.relay.sendEnvelope).not.toHaveBeenCalled();
  });
});
