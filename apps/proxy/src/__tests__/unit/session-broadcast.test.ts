import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionState } from "@dev-anywhere/shared";
import { SessionManager } from "#src/serve/session-manager.js";
import {
  broadcastSessionList,
  broadcastSessionSync,
  changeSessionState,
  changeTerminalCwd,
  touchSessionActivity,
} from "#src/serve/session-broadcast.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

function makeSessionManager(): SessionManager {
  return new SessionManager({
    persistPath: join(mkdtempSync(join(tmpdir(), "session-broadcast-test-")), "sessions.json"),
    allowSessionRuntimeHandover: { terminal: true, worker: true },
  });
}

describe("session broadcast state source", () => {
  let manager: SessionManager | undefined;

  afterEach(() => {
    manager?.stopReaper();
    manager = undefined;
  });

  it("sends the complete authoritative session snapshot after a session is added or removed", () => {
    manager = makeSessionManager();
    const first = manager.createSession(
      "agent",
      "pty",
      "claude",
      "/tmp/first",
      process.pid,
      undefined,
      undefined,
      "local-terminal",
    );
    const second = manager.createSession("agent", "json", "codex", "/tmp/second", process.pid);
    const messages: string[] = [];
    const relay = {
      sendRaw: (raw: string) => messages.push(raw),
    } as unknown as RelayConnection;

    broadcastSessionSync(relay, manager);
    manager.terminateSession(first.id);
    broadcastSessionSync(relay, manager);

    expect(JSON.parse(messages[0])).toMatchObject({
      type: "session_sync",
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ]),
    });
    expect(JSON.parse(messages[0]).sessions).toHaveLength(2);
    expect(JSON.parse(messages[1])).toMatchObject({
      type: "session_sync",
      sessions: [expect.objectContaining({ id: second.id })],
    });
  });

  it("replays in-memory waiting approval state through session_list after browser refresh", () => {
    manager = makeSessionManager();
    const session = manager.createSession(
      "agent",
      "pty",
      "claude",
      "/tmp/project",
      process.pid,
      undefined,
      undefined,
      "local-terminal",
    );
    manager.renameSession(session.id, "Release checklist");
    manager.updateState(session.id, SessionState.WAITING_APPROVAL);
    const envelopes: Array<{
      type: string;
      payload: {
        sessions: Array<{
          sessionId: string;
          kind: "agent" | "terminal";
          state: string;
          cwd?: string;
          name?: string;
          nameLocked?: boolean;
        }>;
      };
    }> = [];
    const relay = {
      sendEnvelope: (envelope: (typeof envelopes)[number]) => envelopes.push(envelope),
    } as unknown as RelayConnection;

    broadcastSessionList(relay, manager);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].type).toBe("session_list");
    expect(envelopes[0].payload.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        kind: "agent",
        state: "waiting_approval",
        cwd: "/tmp/project",
        name: "Release checklist",
        nameLocked: true,
      }),
    );
  });

  it("pushes accepted state transitions through session_status before transient PTY metadata matters", () => {
    manager = makeSessionManager();
    const session = manager.createSession(
      "agent",
      "pty",
      "claude",
      "/tmp/project",
      process.pid,
      undefined,
      undefined,
      "local-terminal",
    );
    const envelopes: Array<{ type: string; payload: { sessionId: string; state: string } }> = [];
    const relay = {
      sendEnvelope: (envelope: (typeof envelopes)[number]) => envelopes.push(envelope),
    } as unknown as RelayConnection;

    const changed = changeSessionState(manager, relay, session.id, SessionState.WAITING_APPROVAL);

    expect(changed).toBe(true);
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        type: "session_status",
        payload: expect.objectContaining({
          sessionId: session.id,
          state: "waiting_approval",
        }),
      }),
    );
  });

  it("broadcasts a pure terminal OSC 7 working-directory change", () => {
    manager = makeSessionManager();
    const session = manager.createSession(
      "terminal",
      "pty",
      "claude",
      "/Users/dev",
      process.pid,
      undefined,
      undefined,
      "proxy-hosted",
    );
    const envelopes: Array<{
      type: string;
      payload: {
        sessions: Array<{ sessionId: string; kind: "agent" | "terminal"; cwd: string }>;
      };
    }> = [];
    const relay = {
      sendEnvelope: (envelope: (typeof envelopes)[number]) => envelopes.push(envelope),
    } as unknown as RelayConnection;

    expect(changeTerminalCwd(manager, relay, session.id, "/Users/dev/repo")).toBe(true);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].payload.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        kind: "terminal",
        cwd: "/Users/dev/repo",
      }),
    );
  });

  it("throttles repeated activity touches while still pushing fresh activity", () => {
    manager = makeSessionManager();
    const session = manager.createSession(
      "agent",
      "pty",
      "claude",
      "/tmp/project",
      process.pid,
      undefined,
      undefined,
      "local-terminal",
    );
    const originalUpdatedAt = session.updatedAt;
    const envelopes: Array<{ type: string; payload: { sessionId: string; lastActive: number } }> =
      [];
    const relay = {
      sendEnvelope: (envelope: (typeof envelopes)[number]) => envelopes.push(envelope),
    } as unknown as RelayConnection;

    expect(touchSessionActivity(manager, relay, session.id, originalUpdatedAt + 1_000)).toBe(false);
    expect(touchSessionActivity(manager, relay, session.id, originalUpdatedAt + 16_000)).toBe(true);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: "session_status",
      payload: {
        sessionId: session.id,
        lastActive: originalUpdatedAt + 16_000,
      },
    });
  });
});
