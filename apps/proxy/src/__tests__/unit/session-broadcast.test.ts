import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionState } from "@dev-anywhere/shared";
import { SessionManager } from "#src/serve/session-manager.js";
import { broadcastSessionList, changeSessionState } from "#src/serve/session-broadcast.js";
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
    manager.updateState(session.id, SessionState.WAITING_APPROVAL);
    const rawMessages: string[] = [];
    const relay = {
      sendRaw: (raw: string) => rawMessages.push(raw),
    } as unknown as RelayConnection;

    broadcastSessionList(relay, manager);

    expect(rawMessages).toHaveLength(1);
    const message = JSON.parse(rawMessages[0]) as {
      type: string;
      payload: { sessions: Array<{ sessionId: string; state: string }> };
    };
    expect(message.type).toBe("session_list");
    expect(message.payload.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        state: "waiting_approval",
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
});
