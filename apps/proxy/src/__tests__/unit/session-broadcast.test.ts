import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionState } from "@dev-anywhere/shared";
import { SessionManager } from "#src/serve/session-manager.js";
import {
  broadcastSessionList,
  changeSessionState,
  changeTerminalCwd,
  touchSessionActivity,
} from "#src/serve/session-broadcast.js";
import type { RelayConnection } from "#src/serve/relay-connection.js";

function makeSessionManager(): SessionManager {
  return new SessionManager({
    persistPath: join(mkdtempSync(join(tmpdir(), "session-broadcast-test-")), "sessions.json"),
  });
}

describe("session broadcast state source", () => {
  let manager: SessionManager | undefined;

  afterEach(() => {
    manager?.stopReaper();
    manager = undefined;
  });

  it("replays in-memory waiting approval state through session_list after browser refresh", () => {
    manager = makeSessionManager();
    const session = manager.createSession("pty", "/tmp/project", process.pid);
    manager.renameSession(session.id, "Release checklist");
    manager.updateState(session.id, SessionState.WAITING_APPROVAL);
    const envelopes: Array<{
      type: string;
      payload: {
        sessions: Array<{
          sessionId: string;
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
        state: "waiting_approval",
        cwd: "/tmp/project",
        name: "Release checklist",
        nameLocked: true,
      }),
    );
  });

  it("pushes accepted state transitions through session_status before transient PTY metadata matters", () => {
    manager = makeSessionManager();
    const session = manager.createSession("pty", "/tmp/project", process.pid);
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
      "pty",
      "/Users/dev",
      process.pid,
      undefined,
      undefined,
      "claude",
      "proxy-hosted",
      undefined,
      "terminal",
    );
    const envelopes: Array<{
      type: string;
      payload: { sessions: Array<{ sessionId: string; cwd: string }> };
    }> = [];
    const relay = {
      sendEnvelope: (envelope: (typeof envelopes)[number]) => envelopes.push(envelope),
    } as unknown as RelayConnection;

    expect(changeTerminalCwd(manager, relay, session.id, "/Users/dev/repo")).toBe(true);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].payload.sessions).toContainEqual(
      expect.objectContaining({ sessionId: session.id, cwd: "/Users/dev/repo" }),
    );
  });

  it("throttles repeated activity touches while still pushing fresh activity", () => {
    manager = makeSessionManager();
    const session = manager.createSession("pty", "/tmp/project", process.pid);
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
